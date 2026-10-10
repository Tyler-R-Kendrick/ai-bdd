/** Translate ai-bdd key names (Playwright style: `Enter`, `Control+A`, `ArrowDown`) into Cua Driver `press_key` arguments. */
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
export interface CuaKey {
  key: string;
  modifiers: string[];
}
const NAMED: Record<string, string> = stryMutAct_9fa48("0") ? {} : (stryCov_9fa48("0"), {
  enter: stryMutAct_9fa48("1") ? "" : (stryCov_9fa48("1"), 'enter'),
  return: stryMutAct_9fa48("2") ? "" : (stryCov_9fa48("2"), 'return'),
  tab: stryMutAct_9fa48("3") ? "" : (stryCov_9fa48("3"), 'tab'),
  escape: stryMutAct_9fa48("4") ? "" : (stryCov_9fa48("4"), 'escape'),
  esc: stryMutAct_9fa48("5") ? "" : (stryCov_9fa48("5"), 'escape'),
  space: stryMutAct_9fa48("6") ? "" : (stryCov_9fa48("6"), 'space'),
  ' ': stryMutAct_9fa48("7") ? "" : (stryCov_9fa48("7"), 'space'),
  backspace: stryMutAct_9fa48("8") ? "" : (stryCov_9fa48("8"), 'backspace'),
  delete: stryMutAct_9fa48("9") ? "" : (stryCov_9fa48("9"), 'delete'),
  del: stryMutAct_9fa48("10") ? "" : (stryCov_9fa48("10"), 'delete'),
  insert: stryMutAct_9fa48("11") ? "" : (stryCov_9fa48("11"), 'insert'),
  home: stryMutAct_9fa48("12") ? "" : (stryCov_9fa48("12"), 'home'),
  end: stryMutAct_9fa48("13") ? "" : (stryCov_9fa48("13"), 'end'),
  pageup: stryMutAct_9fa48("14") ? "" : (stryCov_9fa48("14"), 'pageup'),
  pagedown: stryMutAct_9fa48("15") ? "" : (stryCov_9fa48("15"), 'pagedown'),
  arrowup: stryMutAct_9fa48("16") ? "" : (stryCov_9fa48("16"), 'up'),
  arrowdown: stryMutAct_9fa48("17") ? "" : (stryCov_9fa48("17"), 'down'),
  arrowleft: stryMutAct_9fa48("18") ? "" : (stryCov_9fa48("18"), 'left'),
  arrowright: stryMutAct_9fa48("19") ? "" : (stryCov_9fa48("19"), 'right'),
  up: stryMutAct_9fa48("20") ? "" : (stryCov_9fa48("20"), 'up'),
  down: stryMutAct_9fa48("21") ? "" : (stryCov_9fa48("21"), 'down'),
  left: stryMutAct_9fa48("22") ? "" : (stryCov_9fa48("22"), 'left'),
  right: stryMutAct_9fa48("23") ? "" : (stryCov_9fa48("23"), 'right')
});
const PLATFORM_META = (stryMutAct_9fa48("26") ? process.platform !== 'darwin' : stryMutAct_9fa48("25") ? false : stryMutAct_9fa48("24") ? true : (stryCov_9fa48("24", "25", "26"), process.platform === (stryMutAct_9fa48("27") ? "" : (stryCov_9fa48("27"), 'darwin')))) ? stryMutAct_9fa48("28") ? "" : (stryCov_9fa48("28"), 'cmd') : stryMutAct_9fa48("29") ? "" : (stryCov_9fa48("29"), 'super');
const MODIFIERS: Record<string, string> = stryMutAct_9fa48("30") ? {} : (stryCov_9fa48("30"), {
  control: stryMutAct_9fa48("31") ? "" : (stryCov_9fa48("31"), 'ctrl'),
  ctrl: stryMutAct_9fa48("32") ? "" : (stryCov_9fa48("32"), 'ctrl'),
  shift: stryMutAct_9fa48("33") ? "" : (stryCov_9fa48("33"), 'shift'),
  alt: stryMutAct_9fa48("34") ? "" : (stryCov_9fa48("34"), 'alt'),
  option: stryMutAct_9fa48("35") ? "" : (stryCov_9fa48("35"), 'alt'),
  meta: PLATFORM_META,
  cmd: PLATFORM_META,
  command: PLATFORM_META,
  super: PLATFORM_META,
  win: PLATFORM_META,
  controlormeta: (stryMutAct_9fa48("38") ? process.platform !== 'darwin' : stryMutAct_9fa48("37") ? false : stryMutAct_9fa48("36") ? true : (stryCov_9fa48("36", "37", "38"), process.platform === (stryMutAct_9fa48("39") ? "" : (stryCov_9fa48("39"), 'darwin')))) ? stryMutAct_9fa48("40") ? "" : (stryCov_9fa48("40"), 'cmd') : stryMutAct_9fa48("41") ? "" : (stryCov_9fa48("41"), 'ctrl')
});

/** `Control+Shift+K` -> `{ key: 'K', modifiers: ['ctrl', 'shift'] }`. Returns `undefined` for an empty or unknown spec. */
export function parseKey(spec: string): CuaKey | undefined {
  if (stryMutAct_9fa48("42")) {
    {}
  } else {
    stryCov_9fa48("42");
    if (stryMutAct_9fa48("45") ? spec.length !== 0 : stryMutAct_9fa48("44") ? false : stryMutAct_9fa48("43") ? true : (stryCov_9fa48("43", "44", "45"), spec.length === 0)) return undefined;
    // "+" itself is a key: "Control++" means Control and "+".
    const parts = (stryMutAct_9fa48("48") ? spec !== '+' : stryMutAct_9fa48("47") ? false : stryMutAct_9fa48("46") ? true : (stryCov_9fa48("46", "47", "48"), spec === (stryMutAct_9fa48("49") ? "" : (stryCov_9fa48("49"), '+')))) ? stryMutAct_9fa48("50") ? [] : (stryCov_9fa48("50"), [stryMutAct_9fa48("51") ? "" : (stryCov_9fa48("51"), '+')]) : (stryMutAct_9fa48("52") ? spec.startsWith('++') : (stryCov_9fa48("52"), spec.endsWith(stryMutAct_9fa48("53") ? "" : (stryCov_9fa48("53"), '++')))) ? stryMutAct_9fa48("54") ? [] : (stryCov_9fa48("54"), [...(stryMutAct_9fa48("55") ? spec.split('+') : (stryCov_9fa48("55"), spec.slice(0, stryMutAct_9fa48("56") ? +2 : (stryCov_9fa48("56"), -2)).split(stryMutAct_9fa48("57") ? "" : (stryCov_9fa48("57"), '+')))), stryMutAct_9fa48("58") ? "" : (stryCov_9fa48("58"), '+')]) : spec.split(stryMutAct_9fa48("59") ? "" : (stryCov_9fa48("59"), '+'));
    const keyPart = parts[parts.length - 1] as string;
    const modifiers: string[] = stryMutAct_9fa48("60") ? ["Stryker was here"] : (stryCov_9fa48("60"), []);
    for (const m of stryMutAct_9fa48("61") ? parts : (stryCov_9fa48("61"), parts.slice(0, stryMutAct_9fa48("62") ? +1 : (stryCov_9fa48("62"), -1)))) {
      if (stryMutAct_9fa48("63")) {
        {}
      } else {
        stryCov_9fa48("63");
        const mapped = MODIFIERS[stryMutAct_9fa48("64") ? m.toUpperCase() : (stryCov_9fa48("64"), m.toLowerCase())];
        if (stryMutAct_9fa48("67") ? mapped !== undefined : stryMutAct_9fa48("66") ? false : stryMutAct_9fa48("65") ? true : (stryCov_9fa48("65", "66", "67"), mapped === undefined)) return undefined;
        if (stryMutAct_9fa48("70") ? false : stryMutAct_9fa48("69") ? true : stryMutAct_9fa48("68") ? modifiers.includes(mapped) : (stryCov_9fa48("68", "69", "70"), !modifiers.includes(mapped))) if (stryMutAct_9fa48("71")) {
          ;
        } else {
          stryCov_9fa48("71");
          modifiers.push(mapped);
        }
      }
    }
    const lower = stryMutAct_9fa48("72") ? keyPart.toUpperCase() : (stryCov_9fa48("72"), keyPart.toLowerCase());
    const named = NAMED[lower];
    if (stryMutAct_9fa48("75") ? named === undefined : stryMutAct_9fa48("74") ? false : stryMutAct_9fa48("73") ? true : (stryCov_9fa48("73", "74", "75"), named !== undefined)) return stryMutAct_9fa48("76") ? {} : (stryCov_9fa48("76"), {
      key: named,
      modifiers
    });
    if (stryMutAct_9fa48("78") ? false : stryMutAct_9fa48("77") ? true : (stryCov_9fa48("77", "78"), (stryMutAct_9fa48("82") ? /^f([1-9]|1[^0-2])$/ : stryMutAct_9fa48("81") ? /^f([^1-9]|1[0-2])$/ : stryMutAct_9fa48("80") ? /^f([1-9]|1[0-2])/ : stryMutAct_9fa48("79") ? /f([1-9]|1[0-2])$/ : (stryCov_9fa48("79", "80", "81", "82"), /^f([1-9]|1[0-2])$/)).test(lower))) return stryMutAct_9fa48("83") ? {} : (stryCov_9fa48("83"), {
      key: lower,
      modifiers
    });
    if (stryMutAct_9fa48("86") ? keyPart.length !== 1 : stryMutAct_9fa48("85") ? false : stryMutAct_9fa48("84") ? true : (stryCov_9fa48("84", "85", "86"), keyPart.length === 1)) return stryMutAct_9fa48("87") ? {} : (stryCov_9fa48("87"), {
      key: keyPart,
      modifiers
    });
    return undefined;
  }
}