// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import type { NodeStates, ObservedNode } from '@ai-bdd/sdk/contracts';

/**
 * One row of `get_window_state`'s `structuredContent.elements` (the fields ai-bdd uses). The driver reports the platform's
 * accessibility tree: AT-SPI role names on Linux (`push button`, `entry`, `check box`), their UIA / AX counterparts elsewhere.
 */
export interface CuaElement {
  element_index: number;
  element_token: string;
  role: string;
  label?: string;
  value?: string;
  description?: string;
  enabled?: boolean;
  selected?: boolean;
  checked?: boolean;
  expanded?: boolean;
  focused?: boolean;
  parent_index?: number;
  in_web_content?: boolean;
  actions?: string[];
}
function isRecord(v: unknown): v is Record<string, unknown> {
  if (stryMutAct_9fa48("88")) {
    {}
  } else {
    stryCov_9fa48("88");
    return stryMutAct_9fa48("91") ? typeof v === 'object' && v !== null || !Array.isArray(v) : stryMutAct_9fa48("90") ? false : stryMutAct_9fa48("89") ? true : (stryCov_9fa48("89", "90", "91"), (stryMutAct_9fa48("93") ? typeof v === 'object' || v !== null : stryMutAct_9fa48("92") ? true : (stryCov_9fa48("92", "93"), (stryMutAct_9fa48("95") ? typeof v !== 'object' : stryMutAct_9fa48("94") ? true : (stryCov_9fa48("94", "95"), typeof v === (stryMutAct_9fa48("96") ? "" : (stryCov_9fa48("96"), 'object')))) && (stryMutAct_9fa48("98") ? v === null : stryMutAct_9fa48("97") ? true : (stryCov_9fa48("97", "98"), v !== null)))) && (stryMutAct_9fa48("99") ? Array.isArray(v) : (stryCov_9fa48("99"), !Array.isArray(v))));
  }
}
const str = stryMutAct_9fa48("100") ? () => undefined : (stryCov_9fa48("100"), (() => {
  const str = (v: unknown): string | undefined => (stryMutAct_9fa48("103") ? typeof v !== 'string' : stryMutAct_9fa48("102") ? false : stryMutAct_9fa48("101") ? true : (stryCov_9fa48("101", "102", "103"), typeof v === (stryMutAct_9fa48("104") ? "" : (stryCov_9fa48("104"), 'string')))) ? v : undefined;
  return str;
})());
const bool = stryMutAct_9fa48("105") ? () => undefined : (stryCov_9fa48("105"), (() => {
  const bool = (v: unknown): boolean | undefined => (stryMutAct_9fa48("108") ? typeof v !== 'boolean' : stryMutAct_9fa48("107") ? false : stryMutAct_9fa48("106") ? true : (stryCov_9fa48("106", "107", "108"), typeof v === (stryMutAct_9fa48("109") ? "" : (stryCov_9fa48("109"), 'boolean')))) ? v : undefined;
  return bool;
})());

/** Read the `elements` array defensively: a row without an index, token and role is not addressable and is skipped. */
export function parseElements(structured: Record<string, unknown>): CuaElement[] {
  if (stryMutAct_9fa48("110")) {
    {}
  } else {
    stryCov_9fa48("110");
    const rows = structured[stryMutAct_9fa48("111") ? "" : (stryCov_9fa48("111"), 'elements')];
    if (stryMutAct_9fa48("114") ? false : stryMutAct_9fa48("113") ? true : stryMutAct_9fa48("112") ? Array.isArray(rows) : (stryCov_9fa48("112", "113", "114"), !Array.isArray(rows))) return stryMutAct_9fa48("115") ? ["Stryker was here"] : (stryCov_9fa48("115"), []);
    const out: CuaElement[] = stryMutAct_9fa48("116") ? ["Stryker was here"] : (stryCov_9fa48("116"), []);
    for (const row of rows as unknown[]) {
      if (stryMutAct_9fa48("117")) {
        {}
      } else {
        stryCov_9fa48("117");
        if (stryMutAct_9fa48("120") ? false : stryMutAct_9fa48("119") ? true : stryMutAct_9fa48("118") ? isRecord(row) : (stryCov_9fa48("118", "119", "120"), !isRecord(row))) continue;
        const index = row[stryMutAct_9fa48("121") ? "" : (stryCov_9fa48("121"), 'element_index')];
        const token = str(row[stryMutAct_9fa48("122") ? "" : (stryCov_9fa48("122"), 'element_token')]);
        const role = str(row[stryMutAct_9fa48("123") ? "" : (stryCov_9fa48("123"), 'role')]);
        if (stryMutAct_9fa48("126") ? (typeof index !== 'number' || !Number.isInteger(index) || token === undefined) && role === undefined : stryMutAct_9fa48("125") ? false : stryMutAct_9fa48("124") ? true : (stryCov_9fa48("124", "125", "126"), (stryMutAct_9fa48("128") ? (typeof index !== 'number' || !Number.isInteger(index)) && token === undefined : stryMutAct_9fa48("127") ? false : (stryCov_9fa48("127", "128"), (stryMutAct_9fa48("130") ? typeof index !== 'number' && !Number.isInteger(index) : stryMutAct_9fa48("129") ? false : (stryCov_9fa48("129", "130"), (stryMutAct_9fa48("132") ? typeof index === 'number' : stryMutAct_9fa48("131") ? false : (stryCov_9fa48("131", "132"), typeof index !== (stryMutAct_9fa48("133") ? "" : (stryCov_9fa48("133"), 'number')))) || (stryMutAct_9fa48("134") ? Number.isInteger(index) : (stryCov_9fa48("134"), !Number.isInteger(index))))) || (stryMutAct_9fa48("136") ? token !== undefined : stryMutAct_9fa48("135") ? false : (stryCov_9fa48("135", "136"), token === undefined)))) || (stryMutAct_9fa48("138") ? role !== undefined : stryMutAct_9fa48("137") ? false : (stryCov_9fa48("137", "138"), role === undefined)))) continue;
        const el: CuaElement = stryMutAct_9fa48("139") ? {} : (stryCov_9fa48("139"), {
          element_index: index,
          element_token: token,
          role
        });
        const set = <K extends keyof CuaElement,>(key: K, value: CuaElement[K] | undefined): void => {
          if (stryMutAct_9fa48("140")) {
            {}
          } else {
            stryCov_9fa48("140");
            if (stryMutAct_9fa48("143") ? value === undefined : stryMutAct_9fa48("142") ? false : stryMutAct_9fa48("141") ? true : (stryCov_9fa48("141", "142", "143"), value !== undefined)) el[key] = value;
          }
        };
        set(stryMutAct_9fa48("145") ? "" : (stryCov_9fa48("145"), 'label'), str(row[stryMutAct_9fa48("146") ? "" : (stryCov_9fa48("146"), 'label')]));
        set(stryMutAct_9fa48("148") ? "" : (stryCov_9fa48("148"), 'value'), str(row[stryMutAct_9fa48("149") ? "" : (stryCov_9fa48("149"), 'value')]));
        set(stryMutAct_9fa48("151") ? "" : (stryCov_9fa48("151"), 'description'), str(row[stryMutAct_9fa48("152") ? "" : (stryCov_9fa48("152"), 'description')]));
        set(stryMutAct_9fa48("154") ? "" : (stryCov_9fa48("154"), 'enabled'), bool(row[stryMutAct_9fa48("155") ? "" : (stryCov_9fa48("155"), 'enabled')]));
        set(stryMutAct_9fa48("157") ? "" : (stryCov_9fa48("157"), 'selected'), bool(row[stryMutAct_9fa48("158") ? "" : (stryCov_9fa48("158"), 'selected')]));
        set(stryMutAct_9fa48("160") ? "" : (stryCov_9fa48("160"), 'checked'), bool(row[stryMutAct_9fa48("161") ? "" : (stryCov_9fa48("161"), 'checked')]));
        set(stryMutAct_9fa48("163") ? "" : (stryCov_9fa48("163"), 'expanded'), bool(row[stryMutAct_9fa48("164") ? "" : (stryCov_9fa48("164"), 'expanded')]));
        set(stryMutAct_9fa48("166") ? "" : (stryCov_9fa48("166"), 'focused'), bool(row[stryMutAct_9fa48("167") ? "" : (stryCov_9fa48("167"), 'focused')]));
        set(stryMutAct_9fa48("169") ? "" : (stryCov_9fa48("169"), 'in_web_content'), bool(row[stryMutAct_9fa48("170") ? "" : (stryCov_9fa48("170"), 'in_web_content')]));
        if (stryMutAct_9fa48("173") ? typeof row['parent_index'] !== 'number' : stryMutAct_9fa48("172") ? false : stryMutAct_9fa48("171") ? true : (stryCov_9fa48("171", "172", "173"), typeof row[stryMutAct_9fa48("174") ? "" : (stryCov_9fa48("174"), 'parent_index')] === (stryMutAct_9fa48("175") ? "" : (stryCov_9fa48("175"), 'number')))) el.parent_index = row[stryMutAct_9fa48("176") ? "" : (stryCov_9fa48("176"), 'parent_index')];
        if (stryMutAct_9fa48("178") ? false : stryMutAct_9fa48("177") ? true : (stryCov_9fa48("177", "178"), Array.isArray(row[stryMutAct_9fa48("179") ? "" : (stryCov_9fa48("179"), 'actions')]))) el.actions = stryMutAct_9fa48("180") ? row['actions'] as unknown[] : (stryCov_9fa48("180"), (row['actions'] as unknown[]).filter(stryMutAct_9fa48("181") ? () => undefined : (stryCov_9fa48("181"), (a): a is string => stryMutAct_9fa48("184") ? typeof a !== 'string' : stryMutAct_9fa48("183") ? false : stryMutAct_9fa48("182") ? true : (stryCov_9fa48("182", "183", "184"), typeof a === (stryMutAct_9fa48("185") ? "" : (stryCov_9fa48("185"), 'string'))))));
        if (stryMutAct_9fa48("186")) {
          ;
        } else {
          stryCov_9fa48("186");
          out.push(el);
        }
      }
    }
    return stryMutAct_9fa48("187") ? out : (stryCov_9fa48("187"), out.sort(stryMutAct_9fa48("188") ? () => undefined : (stryCov_9fa48("188"), (a, b) => stryMutAct_9fa48("189") ? a.element_index + b.element_index : (stryCov_9fa48("189"), a.element_index - b.element_index))));
  }
}

/** AT-SPI (and UIA / AX style) role names -> the ARIA-ish roles ai-bdd selectors and prompts use. */
const ROLE_MAP: Record<string, string> = stryMutAct_9fa48("190") ? {} : (stryCov_9fa48("190"), {
  'push button': stryMutAct_9fa48("191") ? "" : (stryCov_9fa48("191"), 'button'),
  'toggle button': stryMutAct_9fa48("192") ? "" : (stryCov_9fa48("192"), 'button'),
  button: stryMutAct_9fa48("193") ? "" : (stryCov_9fa48("193"), 'button'),
  'check box': stryMutAct_9fa48("194") ? "" : (stryCov_9fa48("194"), 'checkbox'),
  checkbox: stryMutAct_9fa48("195") ? "" : (stryCov_9fa48("195"), 'checkbox'),
  'radio button': stryMutAct_9fa48("196") ? "" : (stryCov_9fa48("196"), 'radio'),
  radio: stryMutAct_9fa48("197") ? "" : (stryCov_9fa48("197"), 'radio'),
  'check menu item': stryMutAct_9fa48("198") ? "" : (stryCov_9fa48("198"), 'menuitemcheckbox'),
  'radio menu item': stryMutAct_9fa48("199") ? "" : (stryCov_9fa48("199"), 'menuitemradio'),
  entry: stryMutAct_9fa48("200") ? "" : (stryCov_9fa48("200"), 'textbox'),
  text: stryMutAct_9fa48("201") ? "" : (stryCov_9fa48("201"), 'textbox'),
  'password text': stryMutAct_9fa48("202") ? "" : (stryCov_9fa48("202"), 'textbox'),
  edit: stryMutAct_9fa48("203") ? "" : (stryCov_9fa48("203"), 'textbox'),
  'text field': stryMutAct_9fa48("204") ? "" : (stryCov_9fa48("204"), 'textbox'),
  'text box': stryMutAct_9fa48("205") ? "" : (stryCov_9fa48("205"), 'textbox'),
  'text entry': stryMutAct_9fa48("206") ? "" : (stryCov_9fa48("206"), 'textbox'),
  'search box': stryMutAct_9fa48("207") ? "" : (stryCov_9fa48("207"), 'searchbox'),
  'spin button': stryMutAct_9fa48("208") ? "" : (stryCov_9fa48("208"), 'spinbutton'),
  slider: stryMutAct_9fa48("209") ? "" : (stryCov_9fa48("209"), 'slider'),
  switch: stryMutAct_9fa48("210") ? "" : (stryCov_9fa48("210"), 'switch'),
  'combo box': stryMutAct_9fa48("211") ? "" : (stryCov_9fa48("211"), 'combobox'),
  combobox: stryMutAct_9fa48("212") ? "" : (stryCov_9fa48("212"), 'combobox'),
  'list box': stryMutAct_9fa48("213") ? "" : (stryCov_9fa48("213"), 'listbox'),
  list: stryMutAct_9fa48("214") ? "" : (stryCov_9fa48("214"), 'list'),
  'list item': stryMutAct_9fa48("215") ? "" : (stryCov_9fa48("215"), 'listitem'),
  option: stryMutAct_9fa48("216") ? "" : (stryCov_9fa48("216"), 'option'),
  link: stryMutAct_9fa48("217") ? "" : (stryCov_9fa48("217"), 'link'),
  heading: stryMutAct_9fa48("218") ? "" : (stryCov_9fa48("218"), 'heading'),
  paragraph: stryMutAct_9fa48("219") ? "" : (stryCov_9fa48("219"), 'paragraph'),
  label: stryMutAct_9fa48("220") ? "" : (stryCov_9fa48("220"), 'text'),
  static: stryMutAct_9fa48("221") ? "" : (stryCov_9fa48("221"), 'text'),
  'static text': stryMutAct_9fa48("222") ? "" : (stryCov_9fa48("222"), 'text'),
  caption: stryMutAct_9fa48("223") ? "" : (stryCov_9fa48("223"), 'text'),
  image: stryMutAct_9fa48("224") ? "" : (stryCov_9fa48("224"), 'img'),
  icon: stryMutAct_9fa48("225") ? "" : (stryCov_9fa48("225"), 'img'),
  'progress bar': stryMutAct_9fa48("226") ? "" : (stryCov_9fa48("226"), 'progressbar'),
  separator: stryMutAct_9fa48("227") ? "" : (stryCov_9fa48("227"), 'separator'),
  'scroll bar': stryMutAct_9fa48("228") ? "" : (stryCov_9fa48("228"), 'scrollbar'),
  menu: stryMutAct_9fa48("229") ? "" : (stryCov_9fa48("229"), 'menu'),
  'menu bar': stryMutAct_9fa48("230") ? "" : (stryCov_9fa48("230"), 'menubar'),
  'menu item': stryMutAct_9fa48("231") ? "" : (stryCov_9fa48("231"), 'menuitem'),
  'popup menu': stryMutAct_9fa48("232") ? "" : (stryCov_9fa48("232"), 'menu'),
  'tool bar': stryMutAct_9fa48("233") ? "" : (stryCov_9fa48("233"), 'toolbar'),
  toolbar: stryMutAct_9fa48("234") ? "" : (stryCov_9fa48("234"), 'toolbar'),
  'tool tip': stryMutAct_9fa48("235") ? "" : (stryCov_9fa48("235"), 'tooltip'),
  'page tab': stryMutAct_9fa48("236") ? "" : (stryCov_9fa48("236"), 'tab'),
  'page tab list': stryMutAct_9fa48("237") ? "" : (stryCov_9fa48("237"), 'tablist'),
  tab: stryMutAct_9fa48("238") ? "" : (stryCov_9fa48("238"), 'tab'),
  'tab list': stryMutAct_9fa48("239") ? "" : (stryCov_9fa48("239"), 'tablist'),
  table: stryMutAct_9fa48("240") ? "" : (stryCov_9fa48("240"), 'table'),
  'table row': stryMutAct_9fa48("241") ? "" : (stryCov_9fa48("241"), 'row'),
  'table cell': stryMutAct_9fa48("242") ? "" : (stryCov_9fa48("242"), 'cell'),
  'table column header': stryMutAct_9fa48("243") ? "" : (stryCov_9fa48("243"), 'columnheader'),
  'table row header': stryMutAct_9fa48("244") ? "" : (stryCov_9fa48("244"), 'rowheader'),
  'column header': stryMutAct_9fa48("245") ? "" : (stryCov_9fa48("245"), 'columnheader'),
  'row header': stryMutAct_9fa48("246") ? "" : (stryCov_9fa48("246"), 'rowheader'),
  tree: stryMutAct_9fa48("247") ? "" : (stryCov_9fa48("247"), 'tree'),
  'tree item': stryMutAct_9fa48("248") ? "" : (stryCov_9fa48("248"), 'treeitem'),
  'tree table': stryMutAct_9fa48("249") ? "" : (stryCov_9fa48("249"), 'treegrid'),
  dialog: stryMutAct_9fa48("250") ? "" : (stryCov_9fa48("250"), 'dialog'),
  alert: stryMutAct_9fa48("251") ? "" : (stryCov_9fa48("251"), 'alert'),
  'status bar': stryMutAct_9fa48("252") ? "" : (stryCov_9fa48("252"), 'status'),
  form: stryMutAct_9fa48("253") ? "" : (stryCov_9fa48("253"), 'form'),
  'document web': stryMutAct_9fa48("254") ? "" : (stryCov_9fa48("254"), 'document'),
  'document frame': stryMutAct_9fa48("255") ? "" : (stryCov_9fa48("255"), 'document'),
  document: stryMutAct_9fa48("256") ? "" : (stryCov_9fa48("256"), 'document'),
  frame: stryMutAct_9fa48("257") ? "" : (stryCov_9fa48("257"), 'window'),
  window: stryMutAct_9fa48("258") ? "" : (stryCov_9fa48("258"), 'window'),
  'application': stryMutAct_9fa48("259") ? "" : (stryCov_9fa48("259"), 'application'),
  article: stryMutAct_9fa48("260") ? "" : (stryCov_9fa48("260"), 'article'),
  landmark: stryMutAct_9fa48("261") ? "" : (stryCov_9fa48("261"), 'region'),
  grouping: stryMutAct_9fa48("262") ? "" : (stryCov_9fa48("262"), 'group'),
  group: stryMutAct_9fa48("263") ? "" : (stryCov_9fa48("263"), 'group'),
  'list-item': stryMutAct_9fa48("264") ? "" : (stryCov_9fa48("264"), 'listitem'),
  // layout containers: no meaning of their own
  panel: stryMutAct_9fa48("265") ? "" : (stryCov_9fa48("265"), 'generic'),
  section: stryMutAct_9fa48("266") ? "" : (stryCov_9fa48("266"), 'generic'),
  filler: stryMutAct_9fa48("267") ? "" : (stryCov_9fa48("267"), 'generic'),
  'scroll pane': stryMutAct_9fa48("268") ? "" : (stryCov_9fa48("268"), 'generic'),
  'split pane': stryMutAct_9fa48("269") ? "" : (stryCov_9fa48("269"), 'generic'),
  viewport: stryMutAct_9fa48("270") ? "" : (stryCov_9fa48("270"), 'generic'),
  'layered pane': stryMutAct_9fa48("271") ? "" : (stryCov_9fa48("271"), 'generic'),
  'root pane': stryMutAct_9fa48("272") ? "" : (stryCov_9fa48("272"), 'generic'),
  'glass pane': stryMutAct_9fa48("273") ? "" : (stryCov_9fa48("273"), 'generic'),
  canvas: stryMutAct_9fa48("274") ? "" : (stryCov_9fa48("274"), 'generic'),
  'redundant object': stryMutAct_9fa48("275") ? "" : (stryCov_9fa48("275"), 'generic'),
  unknown: stryMutAct_9fa48("276") ? "" : (stryCov_9fa48("276"), 'generic'),
  pane: stryMutAct_9fa48("277") ? "" : (stryCov_9fa48("277"), 'generic'),
  custom: stryMutAct_9fa48("278") ? "" : (stryCov_9fa48("278"), 'generic')
});

/** Platforms spell the same role `push button`, `push-button`, `pushbutton` or `PushButton`: look roles up without separators or case. */
const compact = stryMutAct_9fa48("279") ? () => undefined : (stryCov_9fa48("279"), (() => {
  const compact = (name: string): string => stryMutAct_9fa48("280") ? name.toUpperCase().replace(/[^a-z0-9]+/g, '') : (stryCov_9fa48("280"), name.toLowerCase().replace(stryMutAct_9fa48("282") ? /[a-z0-9]+/g : stryMutAct_9fa48("281") ? /[^a-z0-9]/g : (stryCov_9fa48("281", "282"), /[^a-z0-9]+/g), stryMutAct_9fa48("283") ? "Stryker was here!" : (stryCov_9fa48("283"), '')));
  return compact;
})());
const ROLE_LOOKUP = new Map(Object.entries(ROLE_MAP).map(stryMutAct_9fa48("284") ? () => undefined : (stryCov_9fa48("284"), ([k, v]) => [compact(k), v] as const)));
export function ariaRole(raw: string): string {
  if (stryMutAct_9fa48("285")) {
    {}
  } else {
    stryCov_9fa48("285");
    const mapped = ROLE_LOOKUP.get(compact(raw));
    if (stryMutAct_9fa48("288") ? mapped === undefined : stryMutAct_9fa48("287") ? false : stryMutAct_9fa48("286") ? true : (stryCov_9fa48("286", "287", "288"), mapped !== undefined)) return mapped;
    const slug = stryMutAct_9fa48("290") ? raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : stryMutAct_9fa48("289") ? raw.trim().toUpperCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : (stryCov_9fa48("289", "290"), raw.trim().toLowerCase().replace(stryMutAct_9fa48("292") ? /[a-z0-9]+/g : stryMutAct_9fa48("291") ? /[^a-z0-9]/g : (stryCov_9fa48("291", "292"), /[^a-z0-9]+/g), stryMutAct_9fa48("293") ? "" : (stryCov_9fa48("293"), '-')).replace(stryMutAct_9fa48("297") ? /^-+|-$/g : stryMutAct_9fa48("296") ? /^-+|-+/g : stryMutAct_9fa48("295") ? /^-|-+$/g : stryMutAct_9fa48("294") ? /-+|-+$/g : (stryCov_9fa48("294", "295", "296", "297"), /^-+|-+$/g), stryMutAct_9fa48("298") ? "Stryker was here!" : (stryCov_9fa48("298"), '')));
    return (stryMutAct_9fa48("302") ? slug.length <= 0 : stryMutAct_9fa48("301") ? slug.length >= 0 : stryMutAct_9fa48("300") ? false : stryMutAct_9fa48("299") ? true : (stryCov_9fa48("299", "300", "301", "302"), slug.length > 0)) ? slug : stryMutAct_9fa48("303") ? "" : (stryCov_9fa48("303"), 'generic');
  }
}

/** Roles worth keeping even without a name: they carry structure or are operable. */
const KEEP_UNNAMED = new Set(stryMutAct_9fa48("304") ? [] : (stryCov_9fa48("304"), [stryMutAct_9fa48("305") ? "" : (stryCov_9fa48("305"), 'button'), stryMutAct_9fa48("306") ? "" : (stryCov_9fa48("306"), 'checkbox'), stryMutAct_9fa48("307") ? "" : (stryCov_9fa48("307"), 'radio'), stryMutAct_9fa48("308") ? "" : (stryCov_9fa48("308"), 'textbox'), stryMutAct_9fa48("309") ? "" : (stryCov_9fa48("309"), 'searchbox'), stryMutAct_9fa48("310") ? "" : (stryCov_9fa48("310"), 'spinbutton'), stryMutAct_9fa48("311") ? "" : (stryCov_9fa48("311"), 'slider'), stryMutAct_9fa48("312") ? "" : (stryCov_9fa48("312"), 'switch'), stryMutAct_9fa48("313") ? "" : (stryCov_9fa48("313"), 'combobox'), stryMutAct_9fa48("314") ? "" : (stryCov_9fa48("314"), 'listbox'), stryMutAct_9fa48("315") ? "" : (stryCov_9fa48("315"), 'list'), stryMutAct_9fa48("316") ? "" : (stryCov_9fa48("316"), 'listitem'), stryMutAct_9fa48("317") ? "" : (stryCov_9fa48("317"), 'option'), stryMutAct_9fa48("318") ? "" : (stryCov_9fa48("318"), 'link'), stryMutAct_9fa48("319") ? "" : (stryCov_9fa48("319"), 'menu'), stryMutAct_9fa48("320") ? "" : (stryCov_9fa48("320"), 'menubar'), stryMutAct_9fa48("321") ? "" : (stryCov_9fa48("321"), 'menuitem'), stryMutAct_9fa48("322") ? "" : (stryCov_9fa48("322"), 'menuitemcheckbox'), stryMutAct_9fa48("323") ? "" : (stryCov_9fa48("323"), 'menuitemradio'), stryMutAct_9fa48("324") ? "" : (stryCov_9fa48("324"), 'toolbar'), stryMutAct_9fa48("325") ? "" : (stryCov_9fa48("325"), 'tab'), stryMutAct_9fa48("326") ? "" : (stryCov_9fa48("326"), 'tablist'), stryMutAct_9fa48("327") ? "" : (stryCov_9fa48("327"), 'table'), stryMutAct_9fa48("328") ? "" : (stryCov_9fa48("328"), 'row'), stryMutAct_9fa48("329") ? "" : (stryCov_9fa48("329"), 'cell'), stryMutAct_9fa48("330") ? "" : (stryCov_9fa48("330"), 'columnheader'), stryMutAct_9fa48("331") ? "" : (stryCov_9fa48("331"), 'rowheader'), stryMutAct_9fa48("332") ? "" : (stryCov_9fa48("332"), 'tree'), stryMutAct_9fa48("333") ? "" : (stryCov_9fa48("333"), 'treeitem'), stryMutAct_9fa48("334") ? "" : (stryCov_9fa48("334"), 'treegrid'), stryMutAct_9fa48("335") ? "" : (stryCov_9fa48("335"), 'dialog'), stryMutAct_9fa48("336") ? "" : (stryCov_9fa48("336"), 'alert'), stryMutAct_9fa48("337") ? "" : (stryCov_9fa48("337"), 'status'), stryMutAct_9fa48("338") ? "" : (stryCov_9fa48("338"), 'form'), stryMutAct_9fa48("339") ? "" : (stryCov_9fa48("339"), 'document'), stryMutAct_9fa48("340") ? "" : (stryCov_9fa48("340"), 'window'), stryMutAct_9fa48("341") ? "" : (stryCov_9fa48("341"), 'progressbar'), stryMutAct_9fa48("342") ? "" : (stryCov_9fa48("342"), 'separator'), stryMutAct_9fa48("343") ? "" : (stryCov_9fa48("343"), 'scrollbar'), stryMutAct_9fa48("344") ? "" : (stryCov_9fa48("344"), 'tooltip')]));

/** Object replacement characters stand in for embedded children in AT-SPI labels; they are not text. */
const OBJECT_REPLACEMENT = /￼/g;
const LIST_MARKER = stryMutAct_9fa48("348") ? /^[•◦▪‣]\S*/ : stryMutAct_9fa48("347") ? /^[•◦▪‣]\s/ : stryMutAct_9fa48("346") ? /^[^•◦▪‣]\s*/ : stryMutAct_9fa48("345") ? /[•◦▪‣]\s*/ : (stryCov_9fa48("345", "346", "347", "348"), /^[•◦▪‣]\s*/);
export function cleanLabel(raw: string | undefined, role: string): string {
  if (stryMutAct_9fa48("349")) {
    {}
  } else {
    stryCov_9fa48("349");
    if (stryMutAct_9fa48("352") ? raw !== undefined : stryMutAct_9fa48("351") ? false : stryMutAct_9fa48("350") ? true : (stryCov_9fa48("350", "351", "352"), raw === undefined)) return stryMutAct_9fa48("353") ? "Stryker was here!" : (stryCov_9fa48("353"), '');
    let text = stryMutAct_9fa48("354") ? raw.replace(OBJECT_REPLACEMENT, '').replace(/\s+/g, ' ') : (stryCov_9fa48("354"), raw.replace(OBJECT_REPLACEMENT, stryMutAct_9fa48("355") ? "Stryker was here!" : (stryCov_9fa48("355"), '')).replace(stryMutAct_9fa48("357") ? /\S+/g : stryMutAct_9fa48("356") ? /\s/g : (stryCov_9fa48("356", "357"), /\s+/g), stryMutAct_9fa48("358") ? "" : (stryCov_9fa48("358"), ' ')).trim());
    if (stryMutAct_9fa48("361") ? role !== 'listitem' : stryMutAct_9fa48("360") ? false : stryMutAct_9fa48("359") ? true : (stryCov_9fa48("359", "360", "361"), role === (stryMutAct_9fa48("362") ? "" : (stryCov_9fa48("362"), 'listitem')))) text = text.replace(LIST_MARKER, stryMutAct_9fa48("363") ? "Stryker was here!" : (stryCov_9fa48("363"), ''));
    return text;
  }
}
const CHECKABLE = new Set(stryMutAct_9fa48("364") ? [] : (stryCov_9fa48("364"), [stryMutAct_9fa48("365") ? "" : (stryCov_9fa48("365"), 'checkbox'), stryMutAct_9fa48("366") ? "" : (stryCov_9fa48("366"), 'radio'), stryMutAct_9fa48("367") ? "" : (stryCov_9fa48("367"), 'switch'), stryMutAct_9fa48("368") ? "" : (stryCov_9fa48("368"), 'menuitemcheckbox'), stryMutAct_9fa48("369") ? "" : (stryCov_9fa48("369"), 'menuitemradio')]));
const SELECTABLE = new Set(stryMutAct_9fa48("370") ? [] : (stryCov_9fa48("370"), [stryMutAct_9fa48("371") ? "" : (stryCov_9fa48("371"), 'tab'), stryMutAct_9fa48("372") ? "" : (stryCov_9fa48("372"), 'option'), stryMutAct_9fa48("373") ? "" : (stryCov_9fa48("373"), 'treeitem'), stryMutAct_9fa48("374") ? "" : (stryCov_9fa48("374"), 'row'), stryMutAct_9fa48("375") ? "" : (stryCov_9fa48("375"), 'cell'), stryMutAct_9fa48("376") ? "" : (stryCov_9fa48("376"), 'menuitem'), stryMutAct_9fa48("377") ? "" : (stryCov_9fa48("377"), 'listitem')]));
export interface BuildOptions {
  /** `content`: only the web content of a browser window (no tabs, address bar or infobars). `window`: everything. */
  scope: 'content' | 'window';
  /** Literal secret values to scrub from names and values. */
  secrets: Iterable<string>;
  minSecretLength?: number;
}
export interface BuiltNodes {
  nodes: ObservedNode[];
  /** ref -> the element handle of THIS snapshot (stale once the next `get_window_state` replaces it). */
  tokens: Map<string, string>;
  /** ref -> current checked state, for check boxes, radios and switches. */
  checked: Map<string, boolean>;
  busy: boolean;
}

/**
 * Turn a snapshot's element rows into ai-bdd's observation nodes: ARIA roles, cleaned names, states, secrets removed,
 * unnamed layout containers pruned (their children move up). Refs are `r<revision>:e<element_index>`.
 */
export function buildNodes(elements: readonly CuaElement[], revision: number, opts: BuildOptions): BuiltNodes {
  if (stryMutAct_9fa48("378")) {
    {}
  } else {
    stryCov_9fa48("378");
    const secrets = stryMutAct_9fa48("379") ? [...opts.secrets] : (stryCov_9fa48("379"), (stryMutAct_9fa48("380") ? [] : (stryCov_9fa48("380"), [...opts.secrets])).filter(stryMutAct_9fa48("381") ? () => undefined : (stryCov_9fa48("381"), s => stryMutAct_9fa48("385") ? s.length < (opts.minSecretLength ?? 4) : stryMutAct_9fa48("384") ? s.length > (opts.minSecretLength ?? 4) : stryMutAct_9fa48("383") ? false : stryMutAct_9fa48("382") ? true : (stryCov_9fa48("382", "383", "384", "385"), s.length >= (stryMutAct_9fa48("386") ? opts.minSecretLength && 4 : (stryCov_9fa48("386"), opts.minSecretLength ?? 4))))));
    const scrub = (text: string): string => {
      if (stryMutAct_9fa48("387")) {
        {}
      } else {
        stryCov_9fa48("387");
        let out = text;
        for (const s of secrets) if (stryMutAct_9fa48("389") ? false : stryMutAct_9fa48("388") ? true : (stryCov_9fa48("388", "389"), out.includes(s))) out = out.split(s).join(stryMutAct_9fa48("390") ? "" : (stryCov_9fa48("390"), '[secret]'));
        return out;
      }
    };
    const included = (stryMutAct_9fa48("393") ? opts.scope !== 'content' : stryMutAct_9fa48("392") ? false : stryMutAct_9fa48("391") ? true : (stryCov_9fa48("391", "392", "393"), opts.scope === (stryMutAct_9fa48("394") ? "" : (stryCov_9fa48("394"), 'content')))) ? stryMutAct_9fa48("395") ? elements : (stryCov_9fa48("395"), elements.filter(stryMutAct_9fa48("396") ? () => undefined : (stryCov_9fa48("396"), e => stryMutAct_9fa48("399") ? e.in_web_content !== true : stryMutAct_9fa48("398") ? false : stryMutAct_9fa48("397") ? true : (stryCov_9fa48("397", "398", "399"), e.in_web_content === (stryMutAct_9fa48("400") ? false : (stryCov_9fa48("400"), true)))))) : stryMutAct_9fa48("401") ? [] : (stryCov_9fa48("401"), [...elements]);
    const byIndex = new Map(elements.map(stryMutAct_9fa48("402") ? () => undefined : (stryCov_9fa48("402"), e => stryMutAct_9fa48("403") ? [] : (stryCov_9fa48("403"), [e.element_index, e]))));
    const keptRefOf = new Map<number, string>();
    const nodes: ObservedNode[] = stryMutAct_9fa48("404") ? ["Stryker was here"] : (stryCov_9fa48("404"), []);
    const tokens = new Map<string, string>();
    const checked = new Map<string, boolean>();
    let busy = stryMutAct_9fa48("405") ? true : (stryCov_9fa48("405"), false);
    const depthOf = new Map<number, number>();
    const keptAncestor = (index: number): number | undefined => {
      if (stryMutAct_9fa48("406")) {
        {}
      } else {
        stryCov_9fa48("406");
        let cur = stryMutAct_9fa48("407") ? byIndex.get(index).parent_index : (stryCov_9fa48("407"), byIndex.get(index)?.parent_index);
        for (let hops = 0; stryMutAct_9fa48("409") ? cur !== undefined || hops < 10_000 : stryMutAct_9fa48("408") ? false : (stryCov_9fa48("408", "409"), (stryMutAct_9fa48("411") ? cur === undefined : stryMutAct_9fa48("410") ? true : (stryCov_9fa48("410", "411"), cur !== undefined)) && (stryMutAct_9fa48("414") ? hops >= 10_000 : stryMutAct_9fa48("413") ? hops <= 10_000 : stryMutAct_9fa48("412") ? true : (stryCov_9fa48("412", "413", "414"), hops < 10_000))); stryMutAct_9fa48("415") ? hops -= 1 : (stryCov_9fa48("415"), hops += 1)) {
          if (stryMutAct_9fa48("416")) {
            {}
          } else {
            stryCov_9fa48("416");
            if (stryMutAct_9fa48("418") ? false : stryMutAct_9fa48("417") ? true : (stryCov_9fa48("417", "418"), keptRefOf.has(cur))) return cur;
            cur = stryMutAct_9fa48("419") ? byIndex.get(cur).parent_index : (stryCov_9fa48("419"), byIndex.get(cur)?.parent_index);
          }
        }
        return undefined;
      }
    };
    for (const el of included) {
      if (stryMutAct_9fa48("420")) {
        {}
      } else {
        stryCov_9fa48("420");
        const role = ariaRole(el.role);
        const isPassword = stryMutAct_9fa48("423") ? compact(el.role) !== 'passwordtext' : stryMutAct_9fa48("422") ? false : stryMutAct_9fa48("421") ? true : (stryCov_9fa48("421", "422", "423"), compact(el.role) === (stryMutAct_9fa48("424") ? "" : (stryCov_9fa48("424"), 'passwordtext')));
        // For an empty off-screen node the driver repeats its "scroll it into view" note as the label: a description is not a name.
        const name = scrub(cleanLabel((stryMutAct_9fa48("427") ? el.label !== undefined || el.label === el.description : stryMutAct_9fa48("426") ? false : stryMutAct_9fa48("425") ? true : (stryCov_9fa48("425", "426", "427"), (stryMutAct_9fa48("429") ? el.label === undefined : stryMutAct_9fa48("428") ? true : (stryCov_9fa48("428", "429"), el.label !== undefined)) && (stryMutAct_9fa48("431") ? el.label !== el.description : stryMutAct_9fa48("430") ? true : (stryCov_9fa48("430", "431"), el.label === el.description)))) ? undefined : el.label, role));
        const rawValue = (stryMutAct_9fa48("434") ? (isPassword || el.value === undefined) && el.value.length === 0 : stryMutAct_9fa48("433") ? false : stryMutAct_9fa48("432") ? true : (stryCov_9fa48("432", "433", "434"), (stryMutAct_9fa48("436") ? isPassword && el.value === undefined : stryMutAct_9fa48("435") ? false : (stryCov_9fa48("435", "436"), isPassword || (stryMutAct_9fa48("438") ? el.value !== undefined : stryMutAct_9fa48("437") ? false : (stryCov_9fa48("437", "438"), el.value === undefined)))) || (stryMutAct_9fa48("440") ? el.value.length !== 0 : stryMutAct_9fa48("439") ? false : (stryCov_9fa48("439", "440"), el.value.length === 0)))) ? undefined : scrub(el.value);
        if (stryMutAct_9fa48("443") ? role !== 'progressbar' : stryMutAct_9fa48("442") ? false : stryMutAct_9fa48("441") ? true : (stryCov_9fa48("441", "442", "443"), role === (stryMutAct_9fa48("444") ? "" : (stryCov_9fa48("444"), 'progressbar')))) busy = stryMutAct_9fa48("445") ? false : (stryCov_9fa48("445"), true);
        if (stryMutAct_9fa48("448") ? name === '' && rawValue === undefined || !KEEP_UNNAMED.has(role) : stryMutAct_9fa48("447") ? false : stryMutAct_9fa48("446") ? true : (stryCov_9fa48("446", "447", "448"), (stryMutAct_9fa48("450") ? name === '' || rawValue === undefined : stryMutAct_9fa48("449") ? true : (stryCov_9fa48("449", "450"), (stryMutAct_9fa48("452") ? name !== '' : stryMutAct_9fa48("451") ? true : (stryCov_9fa48("451", "452"), name === (stryMutAct_9fa48("453") ? "Stryker was here!" : (stryCov_9fa48("453"), '')))) && (stryMutAct_9fa48("455") ? rawValue !== undefined : stryMutAct_9fa48("454") ? true : (stryCov_9fa48("454", "455"), rawValue === undefined)))) && (stryMutAct_9fa48("456") ? KEEP_UNNAMED.has(role) : (stryCov_9fa48("456"), !KEEP_UNNAMED.has(role))))) continue;
        const ref = stryMutAct_9fa48("457") ? `` : (stryCov_9fa48("457"), `r${revision}:e${el.element_index}`);
        const parentIndex = keptAncestor(el.element_index);
        const states: NodeStates = {};
        if (stryMutAct_9fa48("460") ? el.enabled !== false : stryMutAct_9fa48("459") ? false : stryMutAct_9fa48("458") ? true : (stryCov_9fa48("458", "459", "460"), el.enabled === (stryMutAct_9fa48("461") ? true : (stryCov_9fa48("461"), false)))) states.disabled = stryMutAct_9fa48("462") ? false : (stryCov_9fa48("462"), true);
        if (stryMutAct_9fa48("464") ? false : stryMutAct_9fa48("463") ? true : (stryCov_9fa48("463", "464"), CHECKABLE.has(role))) {
          if (stryMutAct_9fa48("465")) {
            {}
          } else {
            stryCov_9fa48("465");
            const on = stryMutAct_9fa48("466") ? el.checked && el.selected : (stryCov_9fa48("466"), el.checked ?? el.selected);
            if (stryMutAct_9fa48("469") ? on === undefined : stryMutAct_9fa48("468") ? false : stryMutAct_9fa48("467") ? true : (stryCov_9fa48("467", "468", "469"), on !== undefined)) {
              if (stryMutAct_9fa48("470")) {
                {}
              } else {
                stryCov_9fa48("470");
                states.checked = on;
                if (stryMutAct_9fa48("471")) {
                  ;
                } else {
                  stryCov_9fa48("471");
                  checked.set(ref, on);
                }
              }
            }
          }
        } else if (stryMutAct_9fa48("474") ? el.selected === true || SELECTABLE.has(role) : stryMutAct_9fa48("473") ? false : stryMutAct_9fa48("472") ? true : (stryCov_9fa48("472", "473", "474"), (stryMutAct_9fa48("476") ? el.selected !== true : stryMutAct_9fa48("475") ? true : (stryCov_9fa48("475", "476"), el.selected === (stryMutAct_9fa48("477") ? false : (stryCov_9fa48("477"), true)))) && SELECTABLE.has(role))) states.selected = stryMutAct_9fa48("478") ? false : (stryCov_9fa48("478"), true);
        if (stryMutAct_9fa48("481") ? el.expanded === undefined : stryMutAct_9fa48("480") ? false : stryMutAct_9fa48("479") ? true : (stryCov_9fa48("479", "480", "481"), el.expanded !== undefined)) states.expanded = el.expanded;
        if (stryMutAct_9fa48("484") ? el.focused !== true : stryMutAct_9fa48("483") ? false : stryMutAct_9fa48("482") ? true : (stryCov_9fa48("482", "483", "484"), el.focused === (stryMutAct_9fa48("485") ? false : (stryCov_9fa48("485"), true)))) states.focused = stryMutAct_9fa48("486") ? false : (stryCov_9fa48("486"), true);
        const depth = (stryMutAct_9fa48("489") ? parentIndex !== undefined : stryMutAct_9fa48("488") ? false : stryMutAct_9fa48("487") ? true : (stryCov_9fa48("487", "488", "489"), parentIndex === undefined)) ? 0 : stryMutAct_9fa48("490") ? (depthOf.get(parentIndex) ?? 0) - 1 : (stryCov_9fa48("490"), (stryMutAct_9fa48("491") ? depthOf.get(parentIndex) && 0 : (stryCov_9fa48("491"), depthOf.get(parentIndex) ?? 0)) + 1);
        const node: ObservedNode = stryMutAct_9fa48("492") ? {} : (stryCov_9fa48("492"), {
          ref,
          role,
          name,
          states,
          depth
        });
        if (stryMutAct_9fa48("495") ? rawValue === undefined : stryMutAct_9fa48("494") ? false : stryMutAct_9fa48("493") ? true : (stryCov_9fa48("493", "494", "495"), rawValue !== undefined)) node.value = rawValue;
        if (stryMutAct_9fa48("498") ? parentIndex === undefined : stryMutAct_9fa48("497") ? false : stryMutAct_9fa48("496") ? true : (stryCov_9fa48("496", "497", "498"), parentIndex !== undefined)) node.parentRef = keptRefOf.get(parentIndex) as string;
        if (stryMutAct_9fa48("499")) {
          ;
        } else {
          stryCov_9fa48("499");
          nodes.push(node);
        }
        if (stryMutAct_9fa48("500")) {
          ;
        } else {
          stryCov_9fa48("500");
          keptRefOf.set(el.element_index, ref);
        }
        if (stryMutAct_9fa48("501")) {
          ;
        } else {
          stryCov_9fa48("501");
          depthOf.set(el.element_index, depth);
        }
        if (stryMutAct_9fa48("502")) {
          ;
        } else {
          stryCov_9fa48("502");
          tokens.set(ref, el.element_token);
        }
      }
    }
    return stryMutAct_9fa48("503") ? {} : (stryCov_9fa48("503"), {
      nodes,
      tokens,
      checked,
      busy
    });
  }
}

/** Live regions announce changing text; their text must not decide whether the screen has settled. */
const LIVE_ROLES = new Set(stryMutAct_9fa48("504") ? [] : (stryCov_9fa48("504"), [stryMutAct_9fa48("505") ? "" : (stryCov_9fa48("505"), 'status'), stryMutAct_9fa48("506") ? "" : (stryCov_9fa48("506"), 'timer'), stryMutAct_9fa48("507") ? "" : (stryCov_9fa48("507"), 'log'), stryMutAct_9fa48("508") ? "" : (stryCov_9fa48("508"), 'marquee')]));

/**
 * The hash the settler compares between observations. A walk of the accessibility tree takes about a second, far longer than
 * a clock or a "last synced" indicator holds one value, so the text of live regions is left out (their presence and role still
 * count). The nodes themselves, which checks and the judge read, keep their text.
 */
export function settleHash<H>(nodes: readonly ObservedNode[], hash: (nodes: readonly ObservedNode[]) => H): H {
  if (stryMutAct_9fa48("509")) {
    {}
  } else {
    stryCov_9fa48("509");
    return hash(nodes.map(n => {
      if (stryMutAct_9fa48("510")) {
        {}
      } else {
        stryCov_9fa48("510");
        if (stryMutAct_9fa48("513") ? false : stryMutAct_9fa48("512") ? true : stryMutAct_9fa48("511") ? LIVE_ROLES.has(n.role) : (stryCov_9fa48("511", "512", "513"), !LIVE_ROLES.has(n.role))) return n;
        const {
          value: _value,
          text: _text,
          ...rest
        } = n;
        return stryMutAct_9fa48("514") ? {} : (stryCov_9fa48("514"), {
          ...rest,
          name: stryMutAct_9fa48("515") ? "Stryker was here!" : (stryCov_9fa48("515"), '')
        });
      }
    }));
  }
}