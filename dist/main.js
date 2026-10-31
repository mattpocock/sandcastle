#!/usr/bin/env node
import { createRequire } from 'node:module';
import { NodeContext_exports, withFriendlyErrors, NodeRuntime_exports } from './chunk-DJRHWPEH.js';
import { buildImage, removeImage } from './chunk-CP3TYXZA.js';
import { CommitPrototype, dual, GenericTag, fromIterable, failSync, map2, reduce, Effect_exports, Display, InitError, Layer_exports, ClackDisplay, decode, mapError, TreeFormatter, empty, none, flatMap3, catchAll, match, fail2 as fail2$1, map3, merge, some, right, left, isNonEmptyReadonlyArray, headNonEmpty, tailNonEmpty, isArray, identity, fromIterable2, fromIterable3, globalValue, contextWithEffect, getOrElse, getOption, appendAll, matchEffect, unify, catchSome, zipRight, matchLeft, defaultImageName, Option_exports, SANDBOX_REPO_DIR, FileSystem_exports, ConfigDirError, pipe, zipLeft, log, succeed, isOption, make4, update, repeatN, get2, getSomes, map, zipWith, make3, as, prepend, make, isEmpty, empty2, isEmptyReadonlyArray, of, catchTag, isTagged, die, isConfigError, isMissingDataOnly, filterMap, get, every, mapBoth, zip, forEach, _void, orElse, match2, join as join$1, isConfig, isObject, toStringUnknown, isSome, getOrThrow, FileSystem, try_, flatMap2, unsafeGet, drop, splitAt, tap, take, isQuitException, reduceRight, withMinimumLogLevel, error, PodmanError, mapInput, boolean, sort, contains, append, fromNullable, catchTags, when, set, pipeArguments, head, make10 as make10$1, suspend, get4, allocate, gen, updateAndGet, span, some2, sync, orElse2, has, filter, is, decodeUnknown, String$, fromString, make7 as make7$1, orElseFail, orDie, compose, NumberFromString, Int, Date$, findFirst, allLevels, updateEffect, flatten, fnUntraced, Terminal, QuitException, scoped, isNone, Literal, unlessEffect, asVoid, catchIf, runSync, of2, match3, filterOrDieMessage, Path, filter2, isEffect, taggedEnum, round, ensuring, cons, dieMessage, value, when2, orElse3, isNil, matchRight, symbol2, symbol, cached, findFirstIndex, flatMap, findLast, equals, combine, hash, string, string2, provide, provideServiceEffect, provideService, int } from './chunk-VOG34SRF.js';
import './chunk-BIWNFKGV.js';
import { __commonJS, __require, __toESM, __export } from './chunk-NGBM7T3E.js';
import * as clack from '@clack/prompts';
import { execSync, execFile } from 'child_process';
import { join, resolve, dirname } from 'path';
import { styleText } from 'util';
import { fileURLToPath } from 'url';
import 'module';

createRequire(import.meta.url);

// node_modules/ini/lib/ini.js
var require_ini = __commonJS({
  "node_modules/ini/lib/ini.js"(exports$1, module) {
    var { hasOwnProperty } = Object.prototype;
    var encode = (obj, opt = {}) => {
      if (typeof opt === "string") {
        opt = { section: opt };
      }
      opt.align = opt.align === true;
      opt.newline = opt.newline === true;
      opt.sort = opt.sort === true;
      opt.whitespace = opt.whitespace === true || opt.align === true;
      opt.platform = opt.platform || typeof process !== "undefined" && process.platform;
      opt.bracketedArray = opt.bracketedArray !== false;
      const eol = opt.platform === "win32" ? "\r\n" : "\n";
      const separator = opt.whitespace ? " = " : "=";
      const children = [];
      const keys = opt.sort ? Object.keys(obj).sort() : Object.keys(obj);
      let padToChars = 0;
      if (opt.align) {
        padToChars = safe(
          keys.filter((k) => obj[k] === null || Array.isArray(obj[k]) || typeof obj[k] !== "object").map((k) => Array.isArray(obj[k]) ? `${k}[]` : k).concat([""]).reduce((a, b) => safe(a).length >= safe(b).length ? a : b)
        ).length;
      }
      let out = "";
      const arraySuffix = opt.bracketedArray ? "[]" : "";
      for (const k of keys) {
        const val = obj[k];
        if (val && Array.isArray(val)) {
          for (const item of val) {
            out += safe(`${k}${arraySuffix}`).padEnd(padToChars, " ") + separator + safe(item) + eol;
          }
        } else if (val && typeof val === "object") {
          children.push(k);
        } else {
          out += safe(k).padEnd(padToChars, " ") + separator + safe(val) + eol;
        }
      }
      if (opt.section && out.length) {
        out = "[" + safe(opt.section) + "]" + (opt.newline ? eol + eol : eol) + out;
      }
      for (const k of children) {
        const nk = splitSections(k, ".").join("\\.");
        const section = (opt.section ? opt.section + "." : "") + nk;
        const child = encode(obj[k], {
          ...opt,
          section
        });
        if (out.length && child.length) {
          out += eol;
        }
        out += child;
      }
      return out;
    };
    function splitSections(str, separator) {
      var lastMatchIndex = 0;
      var lastSeparatorIndex = 0;
      var nextIndex = 0;
      var sections = [];
      do {
        nextIndex = str.indexOf(separator, lastMatchIndex);
        if (nextIndex !== -1) {
          lastMatchIndex = nextIndex + separator.length;
          if (nextIndex > 0 && str[nextIndex - 1] === "\\") {
            continue;
          }
          sections.push(str.slice(lastSeparatorIndex, nextIndex));
          lastSeparatorIndex = nextIndex + separator.length;
        }
      } while (nextIndex !== -1);
      sections.push(str.slice(lastSeparatorIndex));
      return sections;
    }
    var decode2 = (str, opt = {}) => {
      opt.bracketedArray = opt.bracketedArray !== false;
      const out = /* @__PURE__ */ Object.create(null);
      let p3 = out;
      let section = null;
      const re = /^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/i;
      const lines2 = str.split(/[\r\n]+/g);
      const duplicates = {};
      for (const line4 of lines2) {
        if (!line4 || line4.match(/^\s*[;#]/) || line4.match(/^\s*$/)) {
          continue;
        }
        const match6 = line4.match(re);
        if (!match6) {
          continue;
        }
        if (match6[1] !== void 0) {
          section = unsafe(match6[1]);
          if (section === "__proto__") {
            p3 = /* @__PURE__ */ Object.create(null);
            continue;
          }
          p3 = out[section] = out[section] || /* @__PURE__ */ Object.create(null);
          continue;
        }
        const keyRaw = unsafe(match6[2]);
        let isArray2;
        if (opt.bracketedArray) {
          isArray2 = keyRaw.length > 2 && keyRaw.slice(-2) === "[]";
        } else {
          duplicates[keyRaw] = (duplicates?.[keyRaw] || 0) + 1;
          isArray2 = duplicates[keyRaw] > 1;
        }
        const key = isArray2 && keyRaw.endsWith("[]") ? keyRaw.slice(0, -2) : keyRaw;
        if (key === "__proto__") {
          continue;
        }
        const valueRaw = match6[3] ? unsafe(match6[4]) : true;
        const value2 = valueRaw === "true" || valueRaw === "false" || valueRaw === "null" ? JSON.parse(valueRaw) : valueRaw;
        if (isArray2) {
          if (!hasOwnProperty.call(p3, key)) {
            p3[key] = [];
          } else if (!Array.isArray(p3[key])) {
            p3[key] = [p3[key]];
          }
        }
        if (Array.isArray(p3[key])) {
          p3[key].push(value2);
        } else {
          p3[key] = value2;
        }
      }
      const remove = [];
      for (const k of Object.keys(out)) {
        if (!hasOwnProperty.call(out, k) || typeof out[k] !== "object" || Array.isArray(out[k])) {
          continue;
        }
        const parts = splitSections(k, ".");
        p3 = out;
        const l = parts.pop();
        const nl = l.replace(/\\\./g, ".");
        for (const part of parts) {
          if (part === "__proto__") {
            continue;
          }
          if (!hasOwnProperty.call(p3, part) || typeof p3[part] !== "object") {
            p3[part] = /* @__PURE__ */ Object.create(null);
          }
          p3 = p3[part];
        }
        if (p3 === out && nl === l) {
          continue;
        }
        p3[nl] = out[k];
        remove.push(k);
      }
      for (const del of remove) {
        delete out[del];
      }
      return out;
    };
    var isQuoted = (val) => {
      return val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'");
    };
    var safe = (val) => {
      if (typeof val !== "string" || val.match(/[=\r\n]/) || val.match(/^\[/) || val.length > 1 && isQuoted(val) || val !== val.trim()) {
        return JSON.stringify(val);
      }
      return val.split(";").join("\\;").split("#").join("\\#");
    };
    var unsafe = (val) => {
      val = (val || "").trim();
      if (isQuoted(val)) {
        if (val.charAt(0) === "'") {
          val = val.slice(1, -1);
        }
        try {
          val = JSON.parse(val);
        } catch {
        }
      } else {
        let esc = false;
        let unesc = "";
        for (let i = 0, l = val.length; i < l; i++) {
          const c = val.charAt(i);
          if (esc) {
            if ("\\;#".indexOf(c) !== -1) {
              unesc += c;
            } else {
              unesc += "\\" + c;
            }
            esc = false;
          } else if (";#".indexOf(c) !== -1) {
            break;
          } else if (c === "\\") {
            esc = true;
          } else {
            unesc += c;
          }
        }
        if (esc) {
          unesc += "\\";
        }
        return unesc.trim();
      }
      return val;
    };
    module.exports = {
      parse: decode2,
      decode: decode2,
      stringify: encode,
      encode,
      safe,
      unsafe
    };
  }
});

// node_modules/toml/lib/parser.js
var require_parser = __commonJS({
  "node_modules/toml/lib/parser.js"(exports$1, module) {
    module.exports = (function() {
      function peg$subclass(child, parent) {
        function ctor() {
          this.constructor = child;
        }
        ctor.prototype = parent.prototype;
        child.prototype = new ctor();
      }
      function SyntaxError(message, expected, found, offset, line4, column3) {
        this.message = message;
        this.expected = expected;
        this.found = found;
        this.offset = offset;
        this.line = line4;
        this.column = column3;
        this.name = "SyntaxError";
      }
      peg$subclass(SyntaxError, Error);
      function parse8(input) {
        var options3 = arguments.length > 1 ? arguments[1] : {}, peg$FAILED = {}, peg$startRuleFunctions = { start: peg$parsestart }, peg$startRuleFunction = peg$parsestart, peg$c1 = function() {
          return nodes;
        }, peg$c2 = peg$FAILED, peg$c3 = "#", peg$c4 = { type: "literal", value: "#", description: '"#"' }, peg$c5 = void 0, peg$c6 = { type: "any", description: "any character" }, peg$c7 = "[", peg$c8 = { type: "literal", value: "[", description: '"["' }, peg$c9 = "]", peg$c10 = { type: "literal", value: "]", description: '"]"' }, peg$c11 = function(name) {
          addNode(node("ObjectPath", name, line4, column3));
        }, peg$c12 = function(name) {
          addNode(node("ArrayPath", name, line4, column3));
        }, peg$c13 = function(parts, name) {
          return parts.concat(name);
        }, peg$c14 = function(name) {
          return [name];
        }, peg$c15 = function(name) {
          return name;
        }, peg$c16 = ".", peg$c17 = { type: "literal", value: ".", description: '"."' }, peg$c18 = "=", peg$c19 = { type: "literal", value: "=", description: '"="' }, peg$c20 = function(key, value2) {
          addNode(node("Assign", value2, line4, column3, key));
        }, peg$c21 = function(chars) {
          return chars.join("");
        }, peg$c22 = function(node2) {
          return node2.value;
        }, peg$c23 = '"""', peg$c24 = { type: "literal", value: '"""', description: '"\\"\\"\\""' }, peg$c25 = null, peg$c26 = function(chars) {
          return node("String", chars.join(""), line4, column3);
        }, peg$c27 = '"', peg$c28 = { type: "literal", value: '"', description: '"\\""' }, peg$c29 = "'''", peg$c30 = { type: "literal", value: "'''", description: `"'''"` }, peg$c31 = "'", peg$c32 = { type: "literal", value: "'", description: `"'"` }, peg$c33 = function(char4) {
          return char4;
        }, peg$c34 = function(char4) {
          return char4;
        }, peg$c35 = "\\", peg$c36 = { type: "literal", value: "\\", description: '"\\\\"' }, peg$c37 = function() {
          return "";
        }, peg$c38 = "e", peg$c39 = { type: "literal", value: "e", description: '"e"' }, peg$c40 = "E", peg$c41 = { type: "literal", value: "E", description: '"E"' }, peg$c42 = function(left2, right2) {
          return node("Float", parseFloat(left2 + "e" + right2), line4, column3);
        }, peg$c43 = function(text10) {
          return node("Float", parseFloat(text10), line4, column3);
        }, peg$c44 = "+", peg$c45 = { type: "literal", value: "+", description: '"+"' }, peg$c46 = function(digits) {
          return digits.join("");
        }, peg$c47 = "-", peg$c48 = { type: "literal", value: "-", description: '"-"' }, peg$c49 = function(digits) {
          return "-" + digits.join("");
        }, peg$c50 = function(text10) {
          return node("Integer", parseInt(text10, 10), line4, column3);
        }, peg$c51 = "true", peg$c52 = { type: "literal", value: "true", description: '"true"' }, peg$c53 = function() {
          return node("Boolean", true, line4, column3);
        }, peg$c54 = "false", peg$c55 = { type: "literal", value: "false", description: '"false"' }, peg$c56 = function() {
          return node("Boolean", false, line4, column3);
        }, peg$c57 = function() {
          return node("Array", [], line4, column3);
        }, peg$c58 = function(value2) {
          return node("Array", value2 ? [value2] : [], line4, column3);
        }, peg$c59 = function(values) {
          return node("Array", values, line4, column3);
        }, peg$c60 = function(values, value2) {
          return node("Array", values.concat(value2), line4, column3);
        }, peg$c61 = function(value2) {
          return value2;
        }, peg$c62 = ",", peg$c63 = { type: "literal", value: ",", description: '","' }, peg$c64 = "{", peg$c65 = { type: "literal", value: "{", description: '"{"' }, peg$c66 = "}", peg$c67 = { type: "literal", value: "}", description: '"}"' }, peg$c68 = function(values) {
          return node("InlineTable", values, line4, column3);
        }, peg$c69 = function(key, value2) {
          return node("InlineTableValue", value2, line4, column3, key);
        }, peg$c70 = function(digits) {
          return "." + digits;
        }, peg$c71 = function(date5) {
          return date5.join("");
        }, peg$c72 = ":", peg$c73 = { type: "literal", value: ":", description: '":"' }, peg$c74 = function(time) {
          return time.join("");
        }, peg$c75 = "T", peg$c76 = { type: "literal", value: "T", description: '"T"' }, peg$c77 = "Z", peg$c78 = { type: "literal", value: "Z", description: '"Z"' }, peg$c79 = function(date5, time) {
          return node("Date", /* @__PURE__ */ new Date(date5 + "T" + time + "Z"), line4, column3);
        }, peg$c80 = function(date5, time) {
          return node("Date", /* @__PURE__ */ new Date(date5 + "T" + time), line4, column3);
        }, peg$c81 = /^[ \t]/, peg$c82 = { type: "class", value: "[ \\t]", description: "[ \\t]" }, peg$c83 = "\n", peg$c84 = { type: "literal", value: "\n", description: '"\\n"' }, peg$c85 = "\r", peg$c86 = { type: "literal", value: "\r", description: '"\\r"' }, peg$c87 = /^[0-9a-f]/i, peg$c88 = { type: "class", value: "[0-9a-f]i", description: "[0-9a-f]i" }, peg$c89 = /^[0-9]/, peg$c90 = { type: "class", value: "[0-9]", description: "[0-9]" }, peg$c91 = "_", peg$c92 = { type: "literal", value: "_", description: '"_"' }, peg$c93 = function() {
          return "";
        }, peg$c94 = /^[A-Za-z0-9_\-]/, peg$c95 = { type: "class", value: "[A-Za-z0-9_\\-]", description: "[A-Za-z0-9_\\-]" }, peg$c96 = function(d) {
          return d.join("");
        }, peg$c97 = '\\"', peg$c98 = { type: "literal", value: '\\"', description: '"\\\\\\""' }, peg$c99 = function() {
          return '"';
        }, peg$c100 = "\\\\", peg$c101 = { type: "literal", value: "\\\\", description: '"\\\\\\\\"' }, peg$c102 = function() {
          return "\\";
        }, peg$c103 = "\\b", peg$c104 = { type: "literal", value: "\\b", description: '"\\\\b"' }, peg$c105 = function() {
          return "\b";
        }, peg$c106 = "\\t", peg$c107 = { type: "literal", value: "\\t", description: '"\\\\t"' }, peg$c108 = function() {
          return "	";
        }, peg$c109 = "\\n", peg$c110 = { type: "literal", value: "\\n", description: '"\\\\n"' }, peg$c111 = function() {
          return "\n";
        }, peg$c112 = "\\f", peg$c113 = { type: "literal", value: "\\f", description: '"\\\\f"' }, peg$c114 = function() {
          return "\f";
        }, peg$c115 = "\\r", peg$c116 = { type: "literal", value: "\\r", description: '"\\\\r"' }, peg$c117 = function() {
          return "\r";
        }, peg$c118 = "\\U", peg$c119 = { type: "literal", value: "\\U", description: '"\\\\U"' }, peg$c120 = function(digits) {
          return convertCodePoint(digits.join(""));
        }, peg$c121 = "\\u", peg$c122 = { type: "literal", value: "\\u", description: '"\\\\u"' }, peg$currPos = 0, peg$reportedPos = 0, peg$cachedPos = 0, peg$cachedPosDetails = { line: 1, column: 1, seenCR: false }, peg$maxFailPos = 0, peg$maxFailExpected = [], peg$silentFails = 0, peg$cache = {}, peg$result;
        if ("startRule" in options3) {
          if (!(options3.startRule in peg$startRuleFunctions)) {
            throw new Error(`Can't start parsing from rule "` + options3.startRule + '".');
          }
          peg$startRuleFunction = peg$startRuleFunctions[options3.startRule];
        }
        function line4() {
          return peg$computePosDetails(peg$reportedPos).line;
        }
        function column3() {
          return peg$computePosDetails(peg$reportedPos).column;
        }
        function peg$computePosDetails(pos) {
          function advance(details, startPos, endPos) {
            var p3, ch;
            for (p3 = startPos; p3 < endPos; p3++) {
              ch = input.charAt(p3);
              if (ch === "\n") {
                if (!details.seenCR) {
                  details.line++;
                }
                details.column = 1;
                details.seenCR = false;
              } else if (ch === "\r" || ch === "\u2028" || ch === "\u2029") {
                details.line++;
                details.column = 1;
                details.seenCR = true;
              } else {
                details.column++;
                details.seenCR = false;
              }
            }
          }
          if (peg$cachedPos !== pos) {
            if (peg$cachedPos > pos) {
              peg$cachedPos = 0;
              peg$cachedPosDetails = { line: 1, column: 1, seenCR: false };
            }
            advance(peg$cachedPosDetails, peg$cachedPos, pos);
            peg$cachedPos = pos;
          }
          return peg$cachedPosDetails;
        }
        function peg$fail(expected2) {
          if (peg$currPos < peg$maxFailPos) {
            return;
          }
          if (peg$currPos > peg$maxFailPos) {
            peg$maxFailPos = peg$currPos;
            peg$maxFailExpected = [];
          }
          peg$maxFailExpected.push(expected2);
        }
        function peg$buildException(message, expected2, pos) {
          function cleanupExpected(expected3) {
            var i = 1;
            expected3.sort(function(a, b) {
              if (a.description < b.description) {
                return -1;
              } else if (a.description > b.description) {
                return 1;
              } else {
                return 0;
              }
            });
            while (i < expected3.length) {
              if (expected3[i - 1] === expected3[i]) {
                expected3.splice(i, 1);
              } else {
                i++;
              }
            }
          }
          function buildMessage(expected3, found2) {
            function stringEscape(s) {
              function hex(ch) {
                return ch.charCodeAt(0).toString(16).toUpperCase();
              }
              return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\x08/g, "\\b").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\f/g, "\\f").replace(/\r/g, "\\r").replace(/[\x00-\x07\x0B\x0E\x0F]/g, function(ch) {
                return "\\x0" + hex(ch);
              }).replace(/[\x10-\x1F\x80-\xFF]/g, function(ch) {
                return "\\x" + hex(ch);
              }).replace(/[\u0180-\u0FFF]/g, function(ch) {
                return "\\u0" + hex(ch);
              }).replace(/[\u1080-\uFFFF]/g, function(ch) {
                return "\\u" + hex(ch);
              });
            }
            var expectedDescs = new Array(expected3.length), expectedDesc, foundDesc, i;
            for (i = 0; i < expected3.length; i++) {
              expectedDescs[i] = expected3[i].description;
            }
            expectedDesc = expected3.length > 1 ? expectedDescs.slice(0, -1).join(", ") + " or " + expectedDescs[expected3.length - 1] : expectedDescs[0];
            foundDesc = found2 ? '"' + stringEscape(found2) + '"' : "end of input";
            return "Expected " + expectedDesc + " but " + foundDesc + " found.";
          }
          var posDetails = peg$computePosDetails(pos), found = pos < input.length ? input.charAt(pos) : null;
          if (expected2 !== null) {
            cleanupExpected(expected2);
          }
          return new SyntaxError(
            buildMessage(expected2, found),
            expected2,
            found,
            pos,
            posDetails.line,
            posDetails.column
          );
        }
        function peg$parsestart() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 0, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parseline();
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parseline();
          }
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c1();
          }
          s0 = s1;
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseline() {
          var s0, s1, s2, s3, s4, s5, s6;
          var key = peg$currPos * 49 + 1, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parseS();
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parseS();
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parseexpression();
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parseS();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parseS();
              }
              if (s3 !== peg$FAILED) {
                s4 = [];
                s5 = peg$parsecomment();
                while (s5 !== peg$FAILED) {
                  s4.push(s5);
                  s5 = peg$parsecomment();
                }
                if (s4 !== peg$FAILED) {
                  s5 = [];
                  s6 = peg$parseNL();
                  if (s6 !== peg$FAILED) {
                    while (s6 !== peg$FAILED) {
                      s5.push(s6);
                      s6 = peg$parseNL();
                    }
                  } else {
                    s5 = peg$c2;
                  }
                  if (s5 === peg$FAILED) {
                    s5 = peg$parseEOF();
                  }
                  if (s5 !== peg$FAILED) {
                    s1 = [s1, s2, s3, s4, s5];
                    s0 = s1;
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = [];
            s2 = peg$parseS();
            if (s2 !== peg$FAILED) {
              while (s2 !== peg$FAILED) {
                s1.push(s2);
                s2 = peg$parseS();
              }
            } else {
              s1 = peg$c2;
            }
            if (s1 !== peg$FAILED) {
              s2 = [];
              s3 = peg$parseNL();
              if (s3 !== peg$FAILED) {
                while (s3 !== peg$FAILED) {
                  s2.push(s3);
                  s3 = peg$parseNL();
                }
              } else {
                s2 = peg$c2;
              }
              if (s2 === peg$FAILED) {
                s2 = peg$parseEOF();
              }
              if (s2 !== peg$FAILED) {
                s1 = [s1, s2];
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
            if (s0 === peg$FAILED) {
              s0 = peg$parseNL();
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseexpression() {
          var s0;
          var key = peg$currPos * 49 + 2, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$parsecomment();
          if (s0 === peg$FAILED) {
            s0 = peg$parsepath();
            if (s0 === peg$FAILED) {
              s0 = peg$parsetablearray();
              if (s0 === peg$FAILED) {
                s0 = peg$parseassignment();
              }
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsecomment() {
          var s0, s1, s2, s3, s4, s5;
          var key = peg$currPos * 49 + 3, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 35) {
            s1 = peg$c3;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c4);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$currPos;
            s4 = peg$currPos;
            peg$silentFails++;
            s5 = peg$parseNL();
            if (s5 === peg$FAILED) {
              s5 = peg$parseEOF();
            }
            peg$silentFails--;
            if (s5 === peg$FAILED) {
              s4 = peg$c5;
            } else {
              peg$currPos = s4;
              s4 = peg$c2;
            }
            if (s4 !== peg$FAILED) {
              if (input.length > peg$currPos) {
                s5 = input.charAt(peg$currPos);
                peg$currPos++;
              } else {
                s5 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c6);
                }
              }
              if (s5 !== peg$FAILED) {
                s4 = [s4, s5];
                s3 = s4;
              } else {
                peg$currPos = s3;
                s3 = peg$c2;
              }
            } else {
              peg$currPos = s3;
              s3 = peg$c2;
            }
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$currPos;
              s4 = peg$currPos;
              peg$silentFails++;
              s5 = peg$parseNL();
              if (s5 === peg$FAILED) {
                s5 = peg$parseEOF();
              }
              peg$silentFails--;
              if (s5 === peg$FAILED) {
                s4 = peg$c5;
              } else {
                peg$currPos = s4;
                s4 = peg$c2;
              }
              if (s4 !== peg$FAILED) {
                if (input.length > peg$currPos) {
                  s5 = input.charAt(peg$currPos);
                  peg$currPos++;
                } else {
                  s5 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c6);
                  }
                }
                if (s5 !== peg$FAILED) {
                  s4 = [s4, s5];
                  s3 = s4;
                } else {
                  peg$currPos = s3;
                  s3 = peg$c2;
                }
              } else {
                peg$currPos = s3;
                s3 = peg$c2;
              }
            }
            if (s2 !== peg$FAILED) {
              s1 = [s1, s2];
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsepath() {
          var s0, s1, s2, s3, s4, s5;
          var key = peg$currPos * 49 + 4, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 91) {
            s1 = peg$c7;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c8);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parseS();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parseS();
            }
            if (s2 !== peg$FAILED) {
              s3 = peg$parsetable_key();
              if (s3 !== peg$FAILED) {
                s4 = [];
                s5 = peg$parseS();
                while (s5 !== peg$FAILED) {
                  s4.push(s5);
                  s5 = peg$parseS();
                }
                if (s4 !== peg$FAILED) {
                  if (input.charCodeAt(peg$currPos) === 93) {
                    s5 = peg$c9;
                    peg$currPos++;
                  } else {
                    s5 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$c10);
                    }
                  }
                  if (s5 !== peg$FAILED) {
                    peg$reportedPos = s0;
                    s1 = peg$c11(s3);
                    s0 = s1;
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsetablearray() {
          var s0, s1, s2, s3, s4, s5, s6, s7;
          var key = peg$currPos * 49 + 5, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 91) {
            s1 = peg$c7;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c8);
            }
          }
          if (s1 !== peg$FAILED) {
            if (input.charCodeAt(peg$currPos) === 91) {
              s2 = peg$c7;
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c8);
              }
            }
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parseS();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parseS();
              }
              if (s3 !== peg$FAILED) {
                s4 = peg$parsetable_key();
                if (s4 !== peg$FAILED) {
                  s5 = [];
                  s6 = peg$parseS();
                  while (s6 !== peg$FAILED) {
                    s5.push(s6);
                    s6 = peg$parseS();
                  }
                  if (s5 !== peg$FAILED) {
                    if (input.charCodeAt(peg$currPos) === 93) {
                      s6 = peg$c9;
                      peg$currPos++;
                    } else {
                      s6 = peg$FAILED;
                      if (peg$silentFails === 0) {
                        peg$fail(peg$c10);
                      }
                    }
                    if (s6 !== peg$FAILED) {
                      if (input.charCodeAt(peg$currPos) === 93) {
                        s7 = peg$c9;
                        peg$currPos++;
                      } else {
                        s7 = peg$FAILED;
                        if (peg$silentFails === 0) {
                          peg$fail(peg$c10);
                        }
                      }
                      if (s7 !== peg$FAILED) {
                        peg$reportedPos = s0;
                        s1 = peg$c12(s4);
                        s0 = s1;
                      } else {
                        peg$currPos = s0;
                        s0 = peg$c2;
                      }
                    } else {
                      peg$currPos = s0;
                      s0 = peg$c2;
                    }
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsetable_key() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 6, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parsedot_ended_table_key_part();
          if (s2 !== peg$FAILED) {
            while (s2 !== peg$FAILED) {
              s1.push(s2);
              s2 = peg$parsedot_ended_table_key_part();
            }
          } else {
            s1 = peg$c2;
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parsetable_key_part();
            if (s2 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c13(s1, s2);
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = peg$parsetable_key_part();
            if (s1 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c14(s1);
            }
            s0 = s1;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsetable_key_part() {
          var s0, s1, s2, s3, s4;
          var key = peg$currPos * 49 + 7, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parseS();
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parseS();
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parsekey();
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parseS();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parseS();
              }
              if (s3 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c15(s2);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = [];
            s2 = peg$parseS();
            while (s2 !== peg$FAILED) {
              s1.push(s2);
              s2 = peg$parseS();
            }
            if (s1 !== peg$FAILED) {
              s2 = peg$parsequoted_key();
              if (s2 !== peg$FAILED) {
                s3 = [];
                s4 = peg$parseS();
                while (s4 !== peg$FAILED) {
                  s3.push(s4);
                  s4 = peg$parseS();
                }
                if (s3 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c15(s2);
                  s0 = s1;
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsedot_ended_table_key_part() {
          var s0, s1, s2, s3, s4, s5, s6;
          var key = peg$currPos * 49 + 8, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parseS();
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parseS();
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parsekey();
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parseS();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parseS();
              }
              if (s3 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 46) {
                  s4 = peg$c16;
                  peg$currPos++;
                } else {
                  s4 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c17);
                  }
                }
                if (s4 !== peg$FAILED) {
                  s5 = [];
                  s6 = peg$parseS();
                  while (s6 !== peg$FAILED) {
                    s5.push(s6);
                    s6 = peg$parseS();
                  }
                  if (s5 !== peg$FAILED) {
                    peg$reportedPos = s0;
                    s1 = peg$c15(s2);
                    s0 = s1;
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = [];
            s2 = peg$parseS();
            while (s2 !== peg$FAILED) {
              s1.push(s2);
              s2 = peg$parseS();
            }
            if (s1 !== peg$FAILED) {
              s2 = peg$parsequoted_key();
              if (s2 !== peg$FAILED) {
                s3 = [];
                s4 = peg$parseS();
                while (s4 !== peg$FAILED) {
                  s3.push(s4);
                  s4 = peg$parseS();
                }
                if (s3 !== peg$FAILED) {
                  if (input.charCodeAt(peg$currPos) === 46) {
                    s4 = peg$c16;
                    peg$currPos++;
                  } else {
                    s4 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$c17);
                    }
                  }
                  if (s4 !== peg$FAILED) {
                    s5 = [];
                    s6 = peg$parseS();
                    while (s6 !== peg$FAILED) {
                      s5.push(s6);
                      s6 = peg$parseS();
                    }
                    if (s5 !== peg$FAILED) {
                      peg$reportedPos = s0;
                      s1 = peg$c15(s2);
                      s0 = s1;
                    } else {
                      peg$currPos = s0;
                      s0 = peg$c2;
                    }
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseassignment() {
          var s0, s1, s2, s3, s4, s5;
          var key = peg$currPos * 49 + 9, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$parsekey();
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parseS();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parseS();
            }
            if (s2 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 61) {
                s3 = peg$c18;
                peg$currPos++;
              } else {
                s3 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c19);
                }
              }
              if (s3 !== peg$FAILED) {
                s4 = [];
                s5 = peg$parseS();
                while (s5 !== peg$FAILED) {
                  s4.push(s5);
                  s5 = peg$parseS();
                }
                if (s4 !== peg$FAILED) {
                  s5 = peg$parsevalue();
                  if (s5 !== peg$FAILED) {
                    peg$reportedPos = s0;
                    s1 = peg$c20(s1, s5);
                    s0 = s1;
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = peg$parsequoted_key();
            if (s1 !== peg$FAILED) {
              s2 = [];
              s3 = peg$parseS();
              while (s3 !== peg$FAILED) {
                s2.push(s3);
                s3 = peg$parseS();
              }
              if (s2 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 61) {
                  s3 = peg$c18;
                  peg$currPos++;
                } else {
                  s3 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c19);
                  }
                }
                if (s3 !== peg$FAILED) {
                  s4 = [];
                  s5 = peg$parseS();
                  while (s5 !== peg$FAILED) {
                    s4.push(s5);
                    s5 = peg$parseS();
                  }
                  if (s4 !== peg$FAILED) {
                    s5 = peg$parsevalue();
                    if (s5 !== peg$FAILED) {
                      peg$reportedPos = s0;
                      s1 = peg$c20(s1, s5);
                      s0 = s1;
                    } else {
                      peg$currPos = s0;
                      s0 = peg$c2;
                    }
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsekey() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 10, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parseASCII_BASIC();
          if (s2 !== peg$FAILED) {
            while (s2 !== peg$FAILED) {
              s1.push(s2);
              s2 = peg$parseASCII_BASIC();
            }
          } else {
            s1 = peg$c2;
          }
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c21(s1);
          }
          s0 = s1;
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsequoted_key() {
          var s0, s1;
          var key = peg$currPos * 49 + 11, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$parsedouble_quoted_single_line_string();
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c22(s1);
          }
          s0 = s1;
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = peg$parsesingle_quoted_single_line_string();
            if (s1 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c22(s1);
            }
            s0 = s1;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsevalue() {
          var s0;
          var key = peg$currPos * 49 + 12, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$parsestring();
          if (s0 === peg$FAILED) {
            s0 = peg$parsedatetime();
            if (s0 === peg$FAILED) {
              s0 = peg$parsefloat();
              if (s0 === peg$FAILED) {
                s0 = peg$parseinteger();
                if (s0 === peg$FAILED) {
                  s0 = peg$parseboolean();
                  if (s0 === peg$FAILED) {
                    s0 = peg$parsearray();
                    if (s0 === peg$FAILED) {
                      s0 = peg$parseinline_table();
                    }
                  }
                }
              }
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsestring() {
          var s0;
          var key = peg$currPos * 49 + 13, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$parsedouble_quoted_multiline_string();
          if (s0 === peg$FAILED) {
            s0 = peg$parsedouble_quoted_single_line_string();
            if (s0 === peg$FAILED) {
              s0 = peg$parsesingle_quoted_multiline_string();
              if (s0 === peg$FAILED) {
                s0 = peg$parsesingle_quoted_single_line_string();
              }
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsedouble_quoted_multiline_string() {
          var s0, s1, s2, s3, s4;
          var key = peg$currPos * 49 + 14, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.substr(peg$currPos, 3) === peg$c23) {
            s1 = peg$c23;
            peg$currPos += 3;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c24);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parseNL();
            if (s2 === peg$FAILED) {
              s2 = peg$c25;
            }
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parsemultiline_string_char();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parsemultiline_string_char();
              }
              if (s3 !== peg$FAILED) {
                if (input.substr(peg$currPos, 3) === peg$c23) {
                  s4 = peg$c23;
                  peg$currPos += 3;
                } else {
                  s4 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c24);
                  }
                }
                if (s4 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c26(s3);
                  s0 = s1;
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsedouble_quoted_single_line_string() {
          var s0, s1, s2, s3;
          var key = peg$currPos * 49 + 15, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 34) {
            s1 = peg$c27;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c28);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parsestring_char();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parsestring_char();
            }
            if (s2 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 34) {
                s3 = peg$c27;
                peg$currPos++;
              } else {
                s3 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c28);
                }
              }
              if (s3 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c26(s2);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsesingle_quoted_multiline_string() {
          var s0, s1, s2, s3, s4;
          var key = peg$currPos * 49 + 16, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.substr(peg$currPos, 3) === peg$c29) {
            s1 = peg$c29;
            peg$currPos += 3;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c30);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parseNL();
            if (s2 === peg$FAILED) {
              s2 = peg$c25;
            }
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parsemultiline_literal_char();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parsemultiline_literal_char();
              }
              if (s3 !== peg$FAILED) {
                if (input.substr(peg$currPos, 3) === peg$c29) {
                  s4 = peg$c29;
                  peg$currPos += 3;
                } else {
                  s4 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c30);
                  }
                }
                if (s4 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c26(s3);
                  s0 = s1;
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsesingle_quoted_single_line_string() {
          var s0, s1, s2, s3;
          var key = peg$currPos * 49 + 17, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 39) {
            s1 = peg$c31;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c32);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parseliteral_char();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parseliteral_char();
            }
            if (s2 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 39) {
                s3 = peg$c31;
                peg$currPos++;
              } else {
                s3 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c32);
                }
              }
              if (s3 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c26(s2);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsestring_char() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 18, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$parseESCAPED();
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = peg$currPos;
            peg$silentFails++;
            if (input.charCodeAt(peg$currPos) === 34) {
              s2 = peg$c27;
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c28);
              }
            }
            peg$silentFails--;
            if (s2 === peg$FAILED) {
              s1 = peg$c5;
            } else {
              peg$currPos = s1;
              s1 = peg$c2;
            }
            if (s1 !== peg$FAILED) {
              if (input.length > peg$currPos) {
                s2 = input.charAt(peg$currPos);
                peg$currPos++;
              } else {
                s2 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c6);
                }
              }
              if (s2 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c33(s2);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseliteral_char() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 19, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$currPos;
          peg$silentFails++;
          if (input.charCodeAt(peg$currPos) === 39) {
            s2 = peg$c31;
            peg$currPos++;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c32);
            }
          }
          peg$silentFails--;
          if (s2 === peg$FAILED) {
            s1 = peg$c5;
          } else {
            peg$currPos = s1;
            s1 = peg$c2;
          }
          if (s1 !== peg$FAILED) {
            if (input.length > peg$currPos) {
              s2 = input.charAt(peg$currPos);
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c6);
              }
            }
            if (s2 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c33(s2);
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsemultiline_string_char() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 20, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$parseESCAPED();
          if (s0 === peg$FAILED) {
            s0 = peg$parsemultiline_string_delim();
            if (s0 === peg$FAILED) {
              s0 = peg$currPos;
              s1 = peg$currPos;
              peg$silentFails++;
              if (input.substr(peg$currPos, 3) === peg$c23) {
                s2 = peg$c23;
                peg$currPos += 3;
              } else {
                s2 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c24);
                }
              }
              peg$silentFails--;
              if (s2 === peg$FAILED) {
                s1 = peg$c5;
              } else {
                peg$currPos = s1;
                s1 = peg$c2;
              }
              if (s1 !== peg$FAILED) {
                if (input.length > peg$currPos) {
                  s2 = input.charAt(peg$currPos);
                  peg$currPos++;
                } else {
                  s2 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c6);
                  }
                }
                if (s2 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c34(s2);
                  s0 = s1;
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsemultiline_string_delim() {
          var s0, s1, s2, s3, s4;
          var key = peg$currPos * 49 + 21, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 92) {
            s1 = peg$c35;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c36);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parseNL();
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parseNLS();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parseNLS();
              }
              if (s3 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c37();
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsemultiline_literal_char() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 22, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$currPos;
          peg$silentFails++;
          if (input.substr(peg$currPos, 3) === peg$c29) {
            s2 = peg$c29;
            peg$currPos += 3;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c30);
            }
          }
          peg$silentFails--;
          if (s2 === peg$FAILED) {
            s1 = peg$c5;
          } else {
            peg$currPos = s1;
            s1 = peg$c2;
          }
          if (s1 !== peg$FAILED) {
            if (input.length > peg$currPos) {
              s2 = input.charAt(peg$currPos);
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c6);
              }
            }
            if (s2 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c33(s2);
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsefloat() {
          var s0, s1, s2, s3;
          var key = peg$currPos * 49 + 23, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$parsefloat_text();
          if (s1 === peg$FAILED) {
            s1 = peg$parseinteger_text();
          }
          if (s1 !== peg$FAILED) {
            if (input.charCodeAt(peg$currPos) === 101) {
              s2 = peg$c38;
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c39);
              }
            }
            if (s2 === peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 69) {
                s2 = peg$c40;
                peg$currPos++;
              } else {
                s2 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c41);
                }
              }
            }
            if (s2 !== peg$FAILED) {
              s3 = peg$parseinteger_text();
              if (s3 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c42(s1, s3);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = peg$parsefloat_text();
            if (s1 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c43(s1);
            }
            s0 = s1;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsefloat_text() {
          var s0, s1, s2, s3, s4, s5;
          var key = peg$currPos * 49 + 24, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 43) {
            s1 = peg$c44;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c45);
            }
          }
          if (s1 === peg$FAILED) {
            s1 = peg$c25;
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            s3 = peg$parseDIGITS();
            if (s3 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 46) {
                s4 = peg$c16;
                peg$currPos++;
              } else {
                s4 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c17);
                }
              }
              if (s4 !== peg$FAILED) {
                s5 = peg$parseDIGITS();
                if (s5 !== peg$FAILED) {
                  s3 = [s3, s4, s5];
                  s2 = s3;
                } else {
                  peg$currPos = s2;
                  s2 = peg$c2;
                }
              } else {
                peg$currPos = s2;
                s2 = peg$c2;
              }
            } else {
              peg$currPos = s2;
              s2 = peg$c2;
            }
            if (s2 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c46(s2);
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.charCodeAt(peg$currPos) === 45) {
              s1 = peg$c47;
              peg$currPos++;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c48);
              }
            }
            if (s1 !== peg$FAILED) {
              s2 = peg$currPos;
              s3 = peg$parseDIGITS();
              if (s3 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 46) {
                  s4 = peg$c16;
                  peg$currPos++;
                } else {
                  s4 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c17);
                  }
                }
                if (s4 !== peg$FAILED) {
                  s5 = peg$parseDIGITS();
                  if (s5 !== peg$FAILED) {
                    s3 = [s3, s4, s5];
                    s2 = s3;
                  } else {
                    peg$currPos = s2;
                    s2 = peg$c2;
                  }
                } else {
                  peg$currPos = s2;
                  s2 = peg$c2;
                }
              } else {
                peg$currPos = s2;
                s2 = peg$c2;
              }
              if (s2 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c49(s2);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseinteger() {
          var s0, s1;
          var key = peg$currPos * 49 + 25, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$parseinteger_text();
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c50(s1);
          }
          s0 = s1;
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseinteger_text() {
          var s0, s1, s2, s3, s4;
          var key = peg$currPos * 49 + 26, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 43) {
            s1 = peg$c44;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c45);
            }
          }
          if (s1 === peg$FAILED) {
            s1 = peg$c25;
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parseDIGIT_OR_UNDER();
            if (s3 !== peg$FAILED) {
              while (s3 !== peg$FAILED) {
                s2.push(s3);
                s3 = peg$parseDIGIT_OR_UNDER();
              }
            } else {
              s2 = peg$c2;
            }
            if (s2 !== peg$FAILED) {
              s3 = peg$currPos;
              peg$silentFails++;
              if (input.charCodeAt(peg$currPos) === 46) {
                s4 = peg$c16;
                peg$currPos++;
              } else {
                s4 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c17);
                }
              }
              peg$silentFails--;
              if (s4 === peg$FAILED) {
                s3 = peg$c5;
              } else {
                peg$currPos = s3;
                s3 = peg$c2;
              }
              if (s3 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c46(s2);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.charCodeAt(peg$currPos) === 45) {
              s1 = peg$c47;
              peg$currPos++;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c48);
              }
            }
            if (s1 !== peg$FAILED) {
              s2 = [];
              s3 = peg$parseDIGIT_OR_UNDER();
              if (s3 !== peg$FAILED) {
                while (s3 !== peg$FAILED) {
                  s2.push(s3);
                  s3 = peg$parseDIGIT_OR_UNDER();
                }
              } else {
                s2 = peg$c2;
              }
              if (s2 !== peg$FAILED) {
                s3 = peg$currPos;
                peg$silentFails++;
                if (input.charCodeAt(peg$currPos) === 46) {
                  s4 = peg$c16;
                  peg$currPos++;
                } else {
                  s4 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c17);
                  }
                }
                peg$silentFails--;
                if (s4 === peg$FAILED) {
                  s3 = peg$c5;
                } else {
                  peg$currPos = s3;
                  s3 = peg$c2;
                }
                if (s3 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c49(s2);
                  s0 = s1;
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseboolean() {
          var s0, s1;
          var key = peg$currPos * 49 + 27, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.substr(peg$currPos, 4) === peg$c51) {
            s1 = peg$c51;
            peg$currPos += 4;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c52);
            }
          }
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c53();
          }
          s0 = s1;
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.substr(peg$currPos, 5) === peg$c54) {
              s1 = peg$c54;
              peg$currPos += 5;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c55);
              }
            }
            if (s1 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c56();
            }
            s0 = s1;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsearray() {
          var s0, s1, s2, s3, s4;
          var key = peg$currPos * 49 + 28, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 91) {
            s1 = peg$c7;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c8);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parsearray_sep();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parsearray_sep();
            }
            if (s2 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 93) {
                s3 = peg$c9;
                peg$currPos++;
              } else {
                s3 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c10);
                }
              }
              if (s3 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c57();
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.charCodeAt(peg$currPos) === 91) {
              s1 = peg$c7;
              peg$currPos++;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c8);
              }
            }
            if (s1 !== peg$FAILED) {
              s2 = peg$parsearray_value();
              if (s2 === peg$FAILED) {
                s2 = peg$c25;
              }
              if (s2 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 93) {
                  s3 = peg$c9;
                  peg$currPos++;
                } else {
                  s3 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c10);
                  }
                }
                if (s3 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c58(s2);
                  s0 = s1;
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
            if (s0 === peg$FAILED) {
              s0 = peg$currPos;
              if (input.charCodeAt(peg$currPos) === 91) {
                s1 = peg$c7;
                peg$currPos++;
              } else {
                s1 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c8);
                }
              }
              if (s1 !== peg$FAILED) {
                s2 = [];
                s3 = peg$parsearray_value_list();
                if (s3 !== peg$FAILED) {
                  while (s3 !== peg$FAILED) {
                    s2.push(s3);
                    s3 = peg$parsearray_value_list();
                  }
                } else {
                  s2 = peg$c2;
                }
                if (s2 !== peg$FAILED) {
                  if (input.charCodeAt(peg$currPos) === 93) {
                    s3 = peg$c9;
                    peg$currPos++;
                  } else {
                    s3 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$c10);
                    }
                  }
                  if (s3 !== peg$FAILED) {
                    peg$reportedPos = s0;
                    s1 = peg$c59(s2);
                    s0 = s1;
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
              if (s0 === peg$FAILED) {
                s0 = peg$currPos;
                if (input.charCodeAt(peg$currPos) === 91) {
                  s1 = peg$c7;
                  peg$currPos++;
                } else {
                  s1 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c8);
                  }
                }
                if (s1 !== peg$FAILED) {
                  s2 = [];
                  s3 = peg$parsearray_value_list();
                  if (s3 !== peg$FAILED) {
                    while (s3 !== peg$FAILED) {
                      s2.push(s3);
                      s3 = peg$parsearray_value_list();
                    }
                  } else {
                    s2 = peg$c2;
                  }
                  if (s2 !== peg$FAILED) {
                    s3 = peg$parsearray_value();
                    if (s3 !== peg$FAILED) {
                      if (input.charCodeAt(peg$currPos) === 93) {
                        s4 = peg$c9;
                        peg$currPos++;
                      } else {
                        s4 = peg$FAILED;
                        if (peg$silentFails === 0) {
                          peg$fail(peg$c10);
                        }
                      }
                      if (s4 !== peg$FAILED) {
                        peg$reportedPos = s0;
                        s1 = peg$c60(s2, s3);
                        s0 = s1;
                      } else {
                        peg$currPos = s0;
                        s0 = peg$c2;
                      }
                    } else {
                      peg$currPos = s0;
                      s0 = peg$c2;
                    }
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              }
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsearray_value() {
          var s0, s1, s2, s3, s4;
          var key = peg$currPos * 49 + 29, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parsearray_sep();
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parsearray_sep();
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parsevalue();
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parsearray_sep();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parsearray_sep();
              }
              if (s3 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c61(s2);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsearray_value_list() {
          var s0, s1, s2, s3, s4, s5, s6;
          var key = peg$currPos * 49 + 30, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parsearray_sep();
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parsearray_sep();
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parsevalue();
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parsearray_sep();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parsearray_sep();
              }
              if (s3 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 44) {
                  s4 = peg$c62;
                  peg$currPos++;
                } else {
                  s4 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c63);
                  }
                }
                if (s4 !== peg$FAILED) {
                  s5 = [];
                  s6 = peg$parsearray_sep();
                  while (s6 !== peg$FAILED) {
                    s5.push(s6);
                    s6 = peg$parsearray_sep();
                  }
                  if (s5 !== peg$FAILED) {
                    peg$reportedPos = s0;
                    s1 = peg$c61(s2);
                    s0 = s1;
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsearray_sep() {
          var s0;
          var key = peg$currPos * 49 + 31, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$parseS();
          if (s0 === peg$FAILED) {
            s0 = peg$parseNL();
            if (s0 === peg$FAILED) {
              s0 = peg$parsecomment();
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseinline_table() {
          var s0, s1, s2, s3, s4, s5;
          var key = peg$currPos * 49 + 32, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 123) {
            s1 = peg$c64;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c65);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parseS();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parseS();
            }
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parseinline_table_assignment();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parseinline_table_assignment();
              }
              if (s3 !== peg$FAILED) {
                s4 = [];
                s5 = peg$parseS();
                while (s5 !== peg$FAILED) {
                  s4.push(s5);
                  s5 = peg$parseS();
                }
                if (s4 !== peg$FAILED) {
                  if (input.charCodeAt(peg$currPos) === 125) {
                    s5 = peg$c66;
                    peg$currPos++;
                  } else {
                    s5 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$c67);
                    }
                  }
                  if (s5 !== peg$FAILED) {
                    peg$reportedPos = s0;
                    s1 = peg$c68(s3);
                    s0 = s1;
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseinline_table_assignment() {
          var s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10;
          var key = peg$currPos * 49 + 33, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parseS();
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parseS();
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parsekey();
            if (s2 !== peg$FAILED) {
              s3 = [];
              s4 = peg$parseS();
              while (s4 !== peg$FAILED) {
                s3.push(s4);
                s4 = peg$parseS();
              }
              if (s3 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 61) {
                  s4 = peg$c18;
                  peg$currPos++;
                } else {
                  s4 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c19);
                  }
                }
                if (s4 !== peg$FAILED) {
                  s5 = [];
                  s6 = peg$parseS();
                  while (s6 !== peg$FAILED) {
                    s5.push(s6);
                    s6 = peg$parseS();
                  }
                  if (s5 !== peg$FAILED) {
                    s6 = peg$parsevalue();
                    if (s6 !== peg$FAILED) {
                      s7 = [];
                      s8 = peg$parseS();
                      while (s8 !== peg$FAILED) {
                        s7.push(s8);
                        s8 = peg$parseS();
                      }
                      if (s7 !== peg$FAILED) {
                        if (input.charCodeAt(peg$currPos) === 44) {
                          s8 = peg$c62;
                          peg$currPos++;
                        } else {
                          s8 = peg$FAILED;
                          if (peg$silentFails === 0) {
                            peg$fail(peg$c63);
                          }
                        }
                        if (s8 !== peg$FAILED) {
                          s9 = [];
                          s10 = peg$parseS();
                          while (s10 !== peg$FAILED) {
                            s9.push(s10);
                            s10 = peg$parseS();
                          }
                          if (s9 !== peg$FAILED) {
                            peg$reportedPos = s0;
                            s1 = peg$c69(s2, s6);
                            s0 = s1;
                          } else {
                            peg$currPos = s0;
                            s0 = peg$c2;
                          }
                        } else {
                          peg$currPos = s0;
                          s0 = peg$c2;
                        }
                      } else {
                        peg$currPos = s0;
                        s0 = peg$c2;
                      }
                    } else {
                      peg$currPos = s0;
                      s0 = peg$c2;
                    }
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = [];
            s2 = peg$parseS();
            while (s2 !== peg$FAILED) {
              s1.push(s2);
              s2 = peg$parseS();
            }
            if (s1 !== peg$FAILED) {
              s2 = peg$parsekey();
              if (s2 !== peg$FAILED) {
                s3 = [];
                s4 = peg$parseS();
                while (s4 !== peg$FAILED) {
                  s3.push(s4);
                  s4 = peg$parseS();
                }
                if (s3 !== peg$FAILED) {
                  if (input.charCodeAt(peg$currPos) === 61) {
                    s4 = peg$c18;
                    peg$currPos++;
                  } else {
                    s4 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$c19);
                    }
                  }
                  if (s4 !== peg$FAILED) {
                    s5 = [];
                    s6 = peg$parseS();
                    while (s6 !== peg$FAILED) {
                      s5.push(s6);
                      s6 = peg$parseS();
                    }
                    if (s5 !== peg$FAILED) {
                      s6 = peg$parsevalue();
                      if (s6 !== peg$FAILED) {
                        peg$reportedPos = s0;
                        s1 = peg$c69(s2, s6);
                        s0 = s1;
                      } else {
                        peg$currPos = s0;
                        s0 = peg$c2;
                      }
                    } else {
                      peg$currPos = s0;
                      s0 = peg$c2;
                    }
                  } else {
                    peg$currPos = s0;
                    s0 = peg$c2;
                  }
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsesecfragment() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 34, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 46) {
            s1 = peg$c16;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c17);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$parseDIGITS();
            if (s2 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c70(s2);
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsedate() {
          var s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11;
          var key = peg$currPos * 49 + 35, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$currPos;
          s2 = peg$parseDIGIT_OR_UNDER();
          if (s2 !== peg$FAILED) {
            s3 = peg$parseDIGIT_OR_UNDER();
            if (s3 !== peg$FAILED) {
              s4 = peg$parseDIGIT_OR_UNDER();
              if (s4 !== peg$FAILED) {
                s5 = peg$parseDIGIT_OR_UNDER();
                if (s5 !== peg$FAILED) {
                  if (input.charCodeAt(peg$currPos) === 45) {
                    s6 = peg$c47;
                    peg$currPos++;
                  } else {
                    s6 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$c48);
                    }
                  }
                  if (s6 !== peg$FAILED) {
                    s7 = peg$parseDIGIT_OR_UNDER();
                    if (s7 !== peg$FAILED) {
                      s8 = peg$parseDIGIT_OR_UNDER();
                      if (s8 !== peg$FAILED) {
                        if (input.charCodeAt(peg$currPos) === 45) {
                          s9 = peg$c47;
                          peg$currPos++;
                        } else {
                          s9 = peg$FAILED;
                          if (peg$silentFails === 0) {
                            peg$fail(peg$c48);
                          }
                        }
                        if (s9 !== peg$FAILED) {
                          s10 = peg$parseDIGIT_OR_UNDER();
                          if (s10 !== peg$FAILED) {
                            s11 = peg$parseDIGIT_OR_UNDER();
                            if (s11 !== peg$FAILED) {
                              s2 = [s2, s3, s4, s5, s6, s7, s8, s9, s10, s11];
                              s1 = s2;
                            } else {
                              peg$currPos = s1;
                              s1 = peg$c2;
                            }
                          } else {
                            peg$currPos = s1;
                            s1 = peg$c2;
                          }
                        } else {
                          peg$currPos = s1;
                          s1 = peg$c2;
                        }
                      } else {
                        peg$currPos = s1;
                        s1 = peg$c2;
                      }
                    } else {
                      peg$currPos = s1;
                      s1 = peg$c2;
                    }
                  } else {
                    peg$currPos = s1;
                    s1 = peg$c2;
                  }
                } else {
                  peg$currPos = s1;
                  s1 = peg$c2;
                }
              } else {
                peg$currPos = s1;
                s1 = peg$c2;
              }
            } else {
              peg$currPos = s1;
              s1 = peg$c2;
            }
          } else {
            peg$currPos = s1;
            s1 = peg$c2;
          }
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c71(s1);
          }
          s0 = s1;
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsetime() {
          var s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10;
          var key = peg$currPos * 49 + 36, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$currPos;
          s2 = peg$parseDIGIT_OR_UNDER();
          if (s2 !== peg$FAILED) {
            s3 = peg$parseDIGIT_OR_UNDER();
            if (s3 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 58) {
                s4 = peg$c72;
                peg$currPos++;
              } else {
                s4 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c73);
                }
              }
              if (s4 !== peg$FAILED) {
                s5 = peg$parseDIGIT_OR_UNDER();
                if (s5 !== peg$FAILED) {
                  s6 = peg$parseDIGIT_OR_UNDER();
                  if (s6 !== peg$FAILED) {
                    if (input.charCodeAt(peg$currPos) === 58) {
                      s7 = peg$c72;
                      peg$currPos++;
                    } else {
                      s7 = peg$FAILED;
                      if (peg$silentFails === 0) {
                        peg$fail(peg$c73);
                      }
                    }
                    if (s7 !== peg$FAILED) {
                      s8 = peg$parseDIGIT_OR_UNDER();
                      if (s8 !== peg$FAILED) {
                        s9 = peg$parseDIGIT_OR_UNDER();
                        if (s9 !== peg$FAILED) {
                          s10 = peg$parsesecfragment();
                          if (s10 === peg$FAILED) {
                            s10 = peg$c25;
                          }
                          if (s10 !== peg$FAILED) {
                            s2 = [s2, s3, s4, s5, s6, s7, s8, s9, s10];
                            s1 = s2;
                          } else {
                            peg$currPos = s1;
                            s1 = peg$c2;
                          }
                        } else {
                          peg$currPos = s1;
                          s1 = peg$c2;
                        }
                      } else {
                        peg$currPos = s1;
                        s1 = peg$c2;
                      }
                    } else {
                      peg$currPos = s1;
                      s1 = peg$c2;
                    }
                  } else {
                    peg$currPos = s1;
                    s1 = peg$c2;
                  }
                } else {
                  peg$currPos = s1;
                  s1 = peg$c2;
                }
              } else {
                peg$currPos = s1;
                s1 = peg$c2;
              }
            } else {
              peg$currPos = s1;
              s1 = peg$c2;
            }
          } else {
            peg$currPos = s1;
            s1 = peg$c2;
          }
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c74(s1);
          }
          s0 = s1;
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsetime_with_offset() {
          var s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15, s16;
          var key = peg$currPos * 49 + 37, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$currPos;
          s2 = peg$parseDIGIT_OR_UNDER();
          if (s2 !== peg$FAILED) {
            s3 = peg$parseDIGIT_OR_UNDER();
            if (s3 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 58) {
                s4 = peg$c72;
                peg$currPos++;
              } else {
                s4 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c73);
                }
              }
              if (s4 !== peg$FAILED) {
                s5 = peg$parseDIGIT_OR_UNDER();
                if (s5 !== peg$FAILED) {
                  s6 = peg$parseDIGIT_OR_UNDER();
                  if (s6 !== peg$FAILED) {
                    if (input.charCodeAt(peg$currPos) === 58) {
                      s7 = peg$c72;
                      peg$currPos++;
                    } else {
                      s7 = peg$FAILED;
                      if (peg$silentFails === 0) {
                        peg$fail(peg$c73);
                      }
                    }
                    if (s7 !== peg$FAILED) {
                      s8 = peg$parseDIGIT_OR_UNDER();
                      if (s8 !== peg$FAILED) {
                        s9 = peg$parseDIGIT_OR_UNDER();
                        if (s9 !== peg$FAILED) {
                          s10 = peg$parsesecfragment();
                          if (s10 === peg$FAILED) {
                            s10 = peg$c25;
                          }
                          if (s10 !== peg$FAILED) {
                            if (input.charCodeAt(peg$currPos) === 45) {
                              s11 = peg$c47;
                              peg$currPos++;
                            } else {
                              s11 = peg$FAILED;
                              if (peg$silentFails === 0) {
                                peg$fail(peg$c48);
                              }
                            }
                            if (s11 === peg$FAILED) {
                              if (input.charCodeAt(peg$currPos) === 43) {
                                s11 = peg$c44;
                                peg$currPos++;
                              } else {
                                s11 = peg$FAILED;
                                if (peg$silentFails === 0) {
                                  peg$fail(peg$c45);
                                }
                              }
                            }
                            if (s11 !== peg$FAILED) {
                              s12 = peg$parseDIGIT_OR_UNDER();
                              if (s12 !== peg$FAILED) {
                                s13 = peg$parseDIGIT_OR_UNDER();
                                if (s13 !== peg$FAILED) {
                                  if (input.charCodeAt(peg$currPos) === 58) {
                                    s14 = peg$c72;
                                    peg$currPos++;
                                  } else {
                                    s14 = peg$FAILED;
                                    if (peg$silentFails === 0) {
                                      peg$fail(peg$c73);
                                    }
                                  }
                                  if (s14 !== peg$FAILED) {
                                    s15 = peg$parseDIGIT_OR_UNDER();
                                    if (s15 !== peg$FAILED) {
                                      s16 = peg$parseDIGIT_OR_UNDER();
                                      if (s16 !== peg$FAILED) {
                                        s2 = [s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15, s16];
                                        s1 = s2;
                                      } else {
                                        peg$currPos = s1;
                                        s1 = peg$c2;
                                      }
                                    } else {
                                      peg$currPos = s1;
                                      s1 = peg$c2;
                                    }
                                  } else {
                                    peg$currPos = s1;
                                    s1 = peg$c2;
                                  }
                                } else {
                                  peg$currPos = s1;
                                  s1 = peg$c2;
                                }
                              } else {
                                peg$currPos = s1;
                                s1 = peg$c2;
                              }
                            } else {
                              peg$currPos = s1;
                              s1 = peg$c2;
                            }
                          } else {
                            peg$currPos = s1;
                            s1 = peg$c2;
                          }
                        } else {
                          peg$currPos = s1;
                          s1 = peg$c2;
                        }
                      } else {
                        peg$currPos = s1;
                        s1 = peg$c2;
                      }
                    } else {
                      peg$currPos = s1;
                      s1 = peg$c2;
                    }
                  } else {
                    peg$currPos = s1;
                    s1 = peg$c2;
                  }
                } else {
                  peg$currPos = s1;
                  s1 = peg$c2;
                }
              } else {
                peg$currPos = s1;
                s1 = peg$c2;
              }
            } else {
              peg$currPos = s1;
              s1 = peg$c2;
            }
          } else {
            peg$currPos = s1;
            s1 = peg$c2;
          }
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c74(s1);
          }
          s0 = s1;
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parsedatetime() {
          var s0, s1, s2, s3, s4;
          var key = peg$currPos * 49 + 38, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = peg$parsedate();
          if (s1 !== peg$FAILED) {
            if (input.charCodeAt(peg$currPos) === 84) {
              s2 = peg$c75;
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c76);
              }
            }
            if (s2 !== peg$FAILED) {
              s3 = peg$parsetime();
              if (s3 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 90) {
                  s4 = peg$c77;
                  peg$currPos++;
                } else {
                  s4 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c78);
                  }
                }
                if (s4 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c79(s1, s3);
                  s0 = s1;
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = peg$parsedate();
            if (s1 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 84) {
                s2 = peg$c75;
                peg$currPos++;
              } else {
                s2 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c76);
                }
              }
              if (s2 !== peg$FAILED) {
                s3 = peg$parsetime_with_offset();
                if (s3 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c80(s1, s3);
                  s0 = s1;
                } else {
                  peg$currPos = s0;
                  s0 = peg$c2;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseS() {
          var s0;
          var key = peg$currPos * 49 + 39, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          if (peg$c81.test(input.charAt(peg$currPos))) {
            s0 = input.charAt(peg$currPos);
            peg$currPos++;
          } else {
            s0 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c82);
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseNL() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 40, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          if (input.charCodeAt(peg$currPos) === 10) {
            s0 = peg$c83;
            peg$currPos++;
          } else {
            s0 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c84);
            }
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.charCodeAt(peg$currPos) === 13) {
              s1 = peg$c85;
              peg$currPos++;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c86);
              }
            }
            if (s1 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 10) {
                s2 = peg$c83;
                peg$currPos++;
              } else {
                s2 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c84);
                }
              }
              if (s2 !== peg$FAILED) {
                s1 = [s1, s2];
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseNLS() {
          var s0;
          var key = peg$currPos * 49 + 41, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$parseNL();
          if (s0 === peg$FAILED) {
            s0 = peg$parseS();
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseEOF() {
          var s0, s1;
          var key = peg$currPos * 49 + 42, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          peg$silentFails++;
          if (input.length > peg$currPos) {
            s1 = input.charAt(peg$currPos);
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c6);
            }
          }
          peg$silentFails--;
          if (s1 === peg$FAILED) {
            s0 = peg$c5;
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseHEX() {
          var s0;
          var key = peg$currPos * 49 + 43, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          if (peg$c87.test(input.charAt(peg$currPos))) {
            s0 = input.charAt(peg$currPos);
            peg$currPos++;
          } else {
            s0 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c88);
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseDIGIT_OR_UNDER() {
          var s0, s1;
          var key = peg$currPos * 49 + 44, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          if (peg$c89.test(input.charAt(peg$currPos))) {
            s0 = input.charAt(peg$currPos);
            peg$currPos++;
          } else {
            s0 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c90);
            }
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.charCodeAt(peg$currPos) === 95) {
              s1 = peg$c91;
              peg$currPos++;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c92);
              }
            }
            if (s1 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c93();
            }
            s0 = s1;
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseASCII_BASIC() {
          var s0;
          var key = peg$currPos * 49 + 45, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          if (peg$c94.test(input.charAt(peg$currPos))) {
            s0 = input.charAt(peg$currPos);
            peg$currPos++;
          } else {
            s0 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c95);
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseDIGITS() {
          var s0, s1, s2;
          var key = peg$currPos * 49 + 46, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parseDIGIT_OR_UNDER();
          if (s2 !== peg$FAILED) {
            while (s2 !== peg$FAILED) {
              s1.push(s2);
              s2 = peg$parseDIGIT_OR_UNDER();
            }
          } else {
            s1 = peg$c2;
          }
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c96(s1);
          }
          s0 = s1;
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseESCAPED() {
          var s0, s1;
          var key = peg$currPos * 49 + 47, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.substr(peg$currPos, 2) === peg$c97) {
            s1 = peg$c97;
            peg$currPos += 2;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c98);
            }
          }
          if (s1 !== peg$FAILED) {
            peg$reportedPos = s0;
            s1 = peg$c99();
          }
          s0 = s1;
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.substr(peg$currPos, 2) === peg$c100) {
              s1 = peg$c100;
              peg$currPos += 2;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c101);
              }
            }
            if (s1 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c102();
            }
            s0 = s1;
            if (s0 === peg$FAILED) {
              s0 = peg$currPos;
              if (input.substr(peg$currPos, 2) === peg$c103) {
                s1 = peg$c103;
                peg$currPos += 2;
              } else {
                s1 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$c104);
                }
              }
              if (s1 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c105();
              }
              s0 = s1;
              if (s0 === peg$FAILED) {
                s0 = peg$currPos;
                if (input.substr(peg$currPos, 2) === peg$c106) {
                  s1 = peg$c106;
                  peg$currPos += 2;
                } else {
                  s1 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$c107);
                  }
                }
                if (s1 !== peg$FAILED) {
                  peg$reportedPos = s0;
                  s1 = peg$c108();
                }
                s0 = s1;
                if (s0 === peg$FAILED) {
                  s0 = peg$currPos;
                  if (input.substr(peg$currPos, 2) === peg$c109) {
                    s1 = peg$c109;
                    peg$currPos += 2;
                  } else {
                    s1 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$c110);
                    }
                  }
                  if (s1 !== peg$FAILED) {
                    peg$reportedPos = s0;
                    s1 = peg$c111();
                  }
                  s0 = s1;
                  if (s0 === peg$FAILED) {
                    s0 = peg$currPos;
                    if (input.substr(peg$currPos, 2) === peg$c112) {
                      s1 = peg$c112;
                      peg$currPos += 2;
                    } else {
                      s1 = peg$FAILED;
                      if (peg$silentFails === 0) {
                        peg$fail(peg$c113);
                      }
                    }
                    if (s1 !== peg$FAILED) {
                      peg$reportedPos = s0;
                      s1 = peg$c114();
                    }
                    s0 = s1;
                    if (s0 === peg$FAILED) {
                      s0 = peg$currPos;
                      if (input.substr(peg$currPos, 2) === peg$c115) {
                        s1 = peg$c115;
                        peg$currPos += 2;
                      } else {
                        s1 = peg$FAILED;
                        if (peg$silentFails === 0) {
                          peg$fail(peg$c116);
                        }
                      }
                      if (s1 !== peg$FAILED) {
                        peg$reportedPos = s0;
                        s1 = peg$c117();
                      }
                      s0 = s1;
                      if (s0 === peg$FAILED) {
                        s0 = peg$parseESCAPED_UNICODE();
                      }
                    }
                  }
                }
              }
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        function peg$parseESCAPED_UNICODE() {
          var s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10;
          var key = peg$currPos * 49 + 48, cached2 = peg$cache[key];
          if (cached2) {
            peg$currPos = cached2.nextPos;
            return cached2.result;
          }
          s0 = peg$currPos;
          if (input.substr(peg$currPos, 2) === peg$c118) {
            s1 = peg$c118;
            peg$currPos += 2;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$c119);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            s3 = peg$parseHEX();
            if (s3 !== peg$FAILED) {
              s4 = peg$parseHEX();
              if (s4 !== peg$FAILED) {
                s5 = peg$parseHEX();
                if (s5 !== peg$FAILED) {
                  s6 = peg$parseHEX();
                  if (s6 !== peg$FAILED) {
                    s7 = peg$parseHEX();
                    if (s7 !== peg$FAILED) {
                      s8 = peg$parseHEX();
                      if (s8 !== peg$FAILED) {
                        s9 = peg$parseHEX();
                        if (s9 !== peg$FAILED) {
                          s10 = peg$parseHEX();
                          if (s10 !== peg$FAILED) {
                            s3 = [s3, s4, s5, s6, s7, s8, s9, s10];
                            s2 = s3;
                          } else {
                            peg$currPos = s2;
                            s2 = peg$c2;
                          }
                        } else {
                          peg$currPos = s2;
                          s2 = peg$c2;
                        }
                      } else {
                        peg$currPos = s2;
                        s2 = peg$c2;
                      }
                    } else {
                      peg$currPos = s2;
                      s2 = peg$c2;
                    }
                  } else {
                    peg$currPos = s2;
                    s2 = peg$c2;
                  }
                } else {
                  peg$currPos = s2;
                  s2 = peg$c2;
                }
              } else {
                peg$currPos = s2;
                s2 = peg$c2;
              }
            } else {
              peg$currPos = s2;
              s2 = peg$c2;
            }
            if (s2 !== peg$FAILED) {
              peg$reportedPos = s0;
              s1 = peg$c120(s2);
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$c2;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.substr(peg$currPos, 2) === peg$c121) {
              s1 = peg$c121;
              peg$currPos += 2;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$c122);
              }
            }
            if (s1 !== peg$FAILED) {
              s2 = peg$currPos;
              s3 = peg$parseHEX();
              if (s3 !== peg$FAILED) {
                s4 = peg$parseHEX();
                if (s4 !== peg$FAILED) {
                  s5 = peg$parseHEX();
                  if (s5 !== peg$FAILED) {
                    s6 = peg$parseHEX();
                    if (s6 !== peg$FAILED) {
                      s3 = [s3, s4, s5, s6];
                      s2 = s3;
                    } else {
                      peg$currPos = s2;
                      s2 = peg$c2;
                    }
                  } else {
                    peg$currPos = s2;
                    s2 = peg$c2;
                  }
                } else {
                  peg$currPos = s2;
                  s2 = peg$c2;
                }
              } else {
                peg$currPos = s2;
                s2 = peg$c2;
              }
              if (s2 !== peg$FAILED) {
                peg$reportedPos = s0;
                s1 = peg$c120(s2);
                s0 = s1;
              } else {
                peg$currPos = s0;
                s0 = peg$c2;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$c2;
            }
          }
          peg$cache[key] = { nextPos: peg$currPos, result: s0 };
          return s0;
        }
        var nodes = [];
        function genError(err, line5, col) {
          var ex = new Error(err);
          ex.line = line5;
          ex.column = col;
          throw ex;
        }
        function addNode(node2) {
          nodes.push(node2);
        }
        function node(type, value2, line5, column4, key) {
          var obj = { type, value: value2, line: line5(), column: column4() };
          if (key) obj.key = key;
          return obj;
        }
        function convertCodePoint(str, line5, col) {
          var num = parseInt("0x" + str);
          if (!isFinite(num) || Math.floor(num) != num || num < 0 || num > 1114111 || num > 55295 && num < 57344) {
            genError("Invalid Unicode escape code: " + str, line5, col);
          } else {
            return fromCodePoint(num);
          }
        }
        function fromCodePoint() {
          var MAX_SIZE = 16384;
          var codeUnits = [];
          var highSurrogate;
          var lowSurrogate;
          var index = -1;
          var length = arguments.length;
          if (!length) {
            return "";
          }
          var result = "";
          while (++index < length) {
            var codePoint = Number(arguments[index]);
            if (codePoint <= 65535) {
              codeUnits.push(codePoint);
            } else {
              codePoint -= 65536;
              highSurrogate = (codePoint >> 10) + 55296;
              lowSurrogate = codePoint % 1024 + 56320;
              codeUnits.push(highSurrogate, lowSurrogate);
            }
            if (index + 1 == length || codeUnits.length > MAX_SIZE) {
              result += String.fromCharCode.apply(null, codeUnits);
              codeUnits.length = 0;
            }
          }
          return result;
        }
        peg$result = peg$startRuleFunction();
        if (peg$result !== peg$FAILED && peg$currPos === input.length) {
          return peg$result;
        } else {
          if (peg$result !== peg$FAILED && peg$currPos < input.length) {
            peg$fail({ type: "end", description: "end of input" });
          }
          throw peg$buildException(null, peg$maxFailExpected, peg$maxFailPos);
        }
      }
      return {
        SyntaxError,
        parse: parse8
      };
    })();
  }
});

// node_modules/toml/lib/compiler.js
var require_compiler = __commonJS({
  "node_modules/toml/lib/compiler.js"(exports$1, module) {
    function compile(nodes) {
      var assignedPaths = [];
      var valueAssignments = [];
      var currentPath = "";
      var data = /* @__PURE__ */ Object.create(null);
      var context = data;
      return reduce3(nodes);
      function reduce3(nodes2) {
        var node;
        for (var i = 0; i < nodes2.length; i++) {
          node = nodes2[i];
          switch (node.type) {
            case "Assign":
              assign(node);
              break;
            case "ObjectPath":
              setPath(node);
              break;
            case "ArrayPath":
              addTableArray(node);
              break;
          }
        }
        return data;
      }
      function genError(err, line4, col) {
        var ex = new Error(err);
        ex.line = line4;
        ex.column = col;
        throw ex;
      }
      function assign(node) {
        var key = node.key;
        var value2 = node.value;
        var line4 = node.line;
        var column3 = node.column;
        var fullPath;
        if (currentPath) {
          fullPath = currentPath + "." + key;
        } else {
          fullPath = key;
        }
        if (typeof context[key] !== "undefined") {
          genError("Cannot redefine existing key '" + fullPath + "'.", line4, column3);
        }
        context[key] = reduceValueNode(value2);
        if (!pathAssigned(fullPath)) {
          assignedPaths.push(fullPath);
          valueAssignments.push(fullPath);
        }
      }
      function pathAssigned(path2) {
        return assignedPaths.indexOf(path2) !== -1;
      }
      function reduceValueNode(node) {
        if (node.type === "Array") {
          return reduceArrayWithTypeChecking(node.value);
        } else if (node.type === "InlineTable") {
          return reduceInlineTableNode(node.value);
        } else {
          return node.value;
        }
      }
      function reduceInlineTableNode(values) {
        var obj = /* @__PURE__ */ Object.create(null);
        for (var i = 0; i < values.length; i++) {
          var val = values[i];
          if (val.value.type === "InlineTable") {
            obj[val.key] = reduceInlineTableNode(val.value.value);
          } else if (val.type === "InlineTableValue") {
            obj[val.key] = reduceValueNode(val.value);
          }
        }
        return obj;
      }
      function setPath(node) {
        var path2 = node.value;
        var quotedPath = path2.map(quoteDottedString).join(".");
        var line4 = node.line;
        var column3 = node.column;
        if (pathAssigned(quotedPath)) {
          genError("Cannot redefine existing key '" + path2 + "'.", line4, column3);
        }
        assignedPaths.push(quotedPath);
        context = deepRef(data, path2, /* @__PURE__ */ Object.create(null), line4, column3);
        currentPath = path2;
      }
      function addTableArray(node) {
        var path2 = node.value;
        var quotedPath = path2.map(quoteDottedString).join(".");
        var line4 = node.line;
        var column3 = node.column;
        if (!pathAssigned(quotedPath)) {
          assignedPaths.push(quotedPath);
        }
        assignedPaths = assignedPaths.filter(function(p3) {
          return p3.indexOf(quotedPath) !== 0;
        });
        assignedPaths.push(quotedPath);
        context = deepRef(data, path2, [], line4, column3);
        currentPath = quotedPath;
        if (context instanceof Array) {
          var newObj = /* @__PURE__ */ Object.create(null);
          context.push(newObj);
          context = newObj;
        } else {
          genError("Cannot redefine existing key '" + path2 + "'.", line4, column3);
        }
      }
      function deepRef(start, keys, value2, line4, column3) {
        var traversed = [];
        var traversedPath = "";
        keys.join(".");
        var ctx = start;
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          traversed.push(key);
          traversedPath = traversed.join(".");
          if (typeof ctx[key] === "undefined") {
            if (i === keys.length - 1) {
              ctx[key] = value2;
            } else {
              ctx[key] = /* @__PURE__ */ Object.create(null);
            }
          } else if (i !== keys.length - 1 && valueAssignments.indexOf(traversedPath) > -1) {
            genError("Cannot redefine existing key '" + traversedPath + "'.", line4, column3);
          }
          ctx = ctx[key];
          if (ctx instanceof Array && ctx.length && i < keys.length - 1) {
            ctx = ctx[ctx.length - 1];
          }
        }
        return ctx;
      }
      function reduceArrayWithTypeChecking(array3) {
        var firstType = null;
        for (var i = 0; i < array3.length; i++) {
          var node = array3[i];
          if (firstType === null) {
            firstType = node.type;
          } else {
            if (node.type !== firstType) {
              genError("Cannot add value of type " + node.type + " to array of type " + firstType + ".", node.line, node.column);
            }
          }
        }
        return array3.map(reduceValueNode);
      }
      function quoteDottedString(str) {
        if (str.indexOf(".") > -1) {
          return '"' + str + '"';
        } else {
          return str;
        }
      }
    }
    module.exports = {
      compile
    };
  }
});

// node_modules/toml/index.js
var require_toml = __commonJS({
  "node_modules/toml/index.js"(exports$1, module) {
    var parser = require_parser();
    var compiler = require_compiler();
    module.exports = {
      parse: function(input) {
        var nodes = parser.parse(input.toString());
        return compiler.compile(nodes);
      }
    };
  }
});

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports$1) {
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports$1.ALIAS = ALIAS;
    exports$1.DOC = DOC;
    exports$1.MAP = MAP;
    exports$1.NODE_TYPE = NODE_TYPE;
    exports$1.PAIR = PAIR;
    exports$1.SCALAR = SCALAR;
    exports$1.SEQ = SEQ;
    exports$1.hasAnchor = hasAnchor;
    exports$1.isAlias = isAlias;
    exports$1.isCollection = isCollection;
    exports$1.isDocument = isDocument;
    exports$1.isMap = isMap;
    exports$1.isNode = isNode;
    exports$1.isPair = isPair;
    exports$1.isScalar = isScalar;
    exports$1.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports$1) {
    var identity2 = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity2.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path2) {
      const ctrl = callVisitor(key, node, visitor, path2);
      if (identity2.isNode(ctrl) || identity2.isPair(ctrl)) {
        replaceNode(key, path2, ctrl);
        return visit_(key, ctrl, visitor, path2);
      }
      if (typeof ctrl !== "symbol") {
        if (identity2.isCollection(node)) {
          path2 = Object.freeze(path2.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path2);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity2.isPair(node)) {
          path2 = Object.freeze(path2.concat(node));
          const ck = visit_("key", node.key, visitor, path2);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path2);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity2.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path2) {
      const ctrl = await callVisitor(key, node, visitor, path2);
      if (identity2.isNode(ctrl) || identity2.isPair(ctrl)) {
        replaceNode(key, path2, ctrl);
        return visitAsync_(key, ctrl, visitor, path2);
      }
      if (typeof ctrl !== "symbol") {
        if (identity2.isCollection(node)) {
          path2 = Object.freeze(path2.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path2);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity2.isPair(node)) {
          path2 = Object.freeze(path2.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path2);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path2);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path2) {
      if (typeof visitor === "function")
        return visitor(key, node, path2);
      if (identity2.isMap(node))
        return visitor.Map?.(key, node, path2);
      if (identity2.isSeq(node))
        return visitor.Seq?.(key, node, path2);
      if (identity2.isPair(node))
        return visitor.Pair?.(key, node, path2);
      if (identity2.isScalar(node))
        return visitor.Scalar?.(key, node, path2);
      if (identity2.isAlias(node))
        return visitor.Alias?.(key, node, path2);
      return void 0;
    }
    function replaceNode(key, path2, node) {
      const parent = path2[path2.length - 1];
      if (identity2.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity2.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity2.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity2.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports$1.visit = visit;
    exports$1.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports$1) {
    var identity2 = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line4, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line4.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error3) {
            onError(String(error3));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines2 = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity2.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity2.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines2.push(`%TAG ${handle} ${prefix}`);
        }
        return lines2.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports$1.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports$1) {
    var identity2 = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity2.isScalar(ref.node) || identity2.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error3 = new Error("Failed to resolve repeated object (this should not happen)");
              error3.source = source;
              throw error3;
            }
          }
        },
        sourceObjects
      };
    }
    exports$1.anchorIsValid = anchorIsValid;
    exports$1.anchorNames = anchorNames;
    exports$1.createNodeAnchors = createNodeAnchors;
    exports$1.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports$1) {
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports$1.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports$1) {
    var identity2 = require_identity();
    function toJS(value2, arg, ctx) {
      if (Array.isArray(value2))
        return value2.map((v, i) => toJS(v, String(i), ctx));
      if (value2 && typeof value2.toJSON === "function") {
        if (!ctx || !identity2.hasAnchor(value2))
          return value2.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value2, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value2.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value2 === "bigint" && !ctx?.keep)
        return Number(value2);
      return value2;
    }
    exports$1.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports$1) {
    var applyReviver = require_applyReviver();
    var identity2 = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity2.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity2.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports$1.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports$1) {
    var anchors = require_anchors();
    var visit = require_visit();
    var identity2 = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity2.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity2.isAlias(node) || identity2.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity2.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity2.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity2.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports$1.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports$1) {
    var identity2 = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value2) => !value2 || typeof value2 !== "function" && typeof value2 !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value2) {
        super(identity2.SCALAR);
        this.value = value2;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports$1.Scalar = Scalar;
    exports$1.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports$1) {
    var Alias = require_Alias();
    var identity2 = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value2, tagName, tags) {
      if (tagName) {
        const match6 = tags.filter((t) => t.tag === tagName);
        const tagObj = match6.find((t) => !t.format) ?? match6[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value2) && !t.format);
    }
    function createNode(value2, tagName, ctx) {
      if (identity2.isDocument(value2))
        value2 = value2.contents;
      if (identity2.isNode(value2))
        return value2;
      if (identity2.isPair(value2)) {
        const map13 = ctx.schema[identity2.MAP].createNode?.(ctx.schema, null, ctx);
        map13.items.push(value2);
        return map13;
      }
      if (value2 instanceof String || value2 instanceof Number || value2 instanceof Boolean || typeof BigInt !== "undefined" && value2 instanceof BigInt) {
        value2 = value2.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value2 && typeof value2 === "object") {
        ref = sourceObjects.get(value2);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value2));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value2, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value2, tagName, schema.tags);
      if (!tagObj) {
        if (value2 && typeof value2.toJSON === "function") {
          value2 = value2.toJSON();
        }
        if (!value2 || typeof value2 !== "object") {
          const node2 = new Scalar.Scalar(value2);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value2 instanceof Map ? schema[identity2.MAP] : Symbol.iterator in Object(value2) ? schema[identity2.SEQ] : schema[identity2.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value2, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value2, ctx) : new Scalar.Scalar(value2);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports$1.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports$1) {
    var createNode = require_createNode();
    var identity2 = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path2, value2) {
      let v = value2;
      for (let i = path2.length - 1; i >= 0; --i) {
        const k = path2[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path2) => path2 == null || typeof path2 === "object" && !!path2[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity2.isNode(it) || identity2.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path2, value2) {
        if (isEmptyPath(path2))
          this.add(value2);
        else {
          const [key, ...rest] = path2;
          const node = this.get(key, true);
          if (identity2.isCollection(node))
            node.addIn(rest, value2);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value2));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path2) {
        const [key, ...rest] = path2;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity2.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path2, keepScalar) {
        const [key, ...rest] = path2;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity2.isScalar(node) ? node.value : node;
        else
          return identity2.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity2.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity2.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path2) {
        const [key, ...rest] = path2;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity2.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path2, value2) {
        const [key, ...rest] = path2;
        if (rest.length === 0) {
          this.set(key, value2);
        } else {
          const node = this.get(key, true);
          if (identity2.isCollection(node))
            node.setIn(rest, value2);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value2));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports$1.Collection = Collection;
    exports$1.collectionFromPath = collectionFromPath;
    exports$1.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports$1) {
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent3) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent3 ? comment.replace(/^(?! *$)/gm, indent3) : comment;
    }
    var lineComment = (str, indent3, comment) => str.endsWith("\n") ? indentComment(comment, indent3) : comment.includes("\n") ? "\n" + indentComment(comment, indent3) : (str.endsWith(" ") ? "" : " ") + comment;
    exports$1.indentComment = indentComment;
    exports$1.lineComment = lineComment;
    exports$1.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports$1) {
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text9, indent3, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text9;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent3.length);
      if (text9.length <= endStep)
        return text9;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent3.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text9, i, indent3.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text9[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text9[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text9, i, indent3.length);
          end = i + indent3.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text9[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text9[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text9;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text9;
      if (onFold)
        onFold();
      let res = text9.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text9.length;
        if (fold === 0)
          res = `
${indent3}${text9.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text9[fold]}\\`;
          res += `
${indent3}${text9.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text9, i, indent3) {
      let end = i;
      let start = i + 1;
      let ch = text9[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent3) {
          ch = text9[++i];
        } else {
          do {
            ch = text9[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text9[start];
        }
      }
      return end;
    }
    exports$1.FOLD_BLOCK = FOLD_BLOCK;
    exports$1.FOLD_FLOW = FOLD_FLOW;
    exports$1.FOLD_QUOTED = FOLD_QUOTED;
    exports$1.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports$1) {
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value2, ctx) {
      const json = JSON.stringify(value2);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent3 = ctx.indent || (containsDocumentMarker(value2) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code2 = json.substr(i + 2, 4);
                switch (code2) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code2.substr(0, 2) === "00")
                      str += "\\x" + code2.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent3;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent3, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value2, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value2.includes("\n") || /[ \t]\n|\n[ \t]/.test(value2))
        return doubleQuotedString(value2, ctx);
      const indent3 = ctx.indent || (containsDocumentMarker(value2) ? "  " : "");
      const res = "'" + value2.replace(/'/g, "''").replace(/\n+/g, `$&
${indent3}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent3, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value2, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value2.includes('"');
        const hasSingle = value2.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value2, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value: value2 }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value2)) {
        return quotedString(value2, ctx);
      }
      const indent3 = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value2) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value2, lineWidth, indent3.length);
      if (!value2)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value2.length; endStart > 0; --endStart) {
        const ch = value2[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value2.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value2 === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value2 = value2.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent3}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value2.length; ++startEnd) {
        const ch = value2[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value2.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value2 = value2.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent3}`);
      }
      const indentSize = indent3 ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value2.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent3}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent3, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent3}${body}`;
      }
      value2 = value2.replace(/\n+/g, `$&${indent3}`);
      return `|${header}
${indent3}${start}${value2}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value: value2 } = item;
      const { actualString, implicitKey, indent: indent3, indentStep, inFlow } = ctx;
      if (implicitKey && value2.includes("\n") || inFlow && /[[\]{},]/.test(value2)) {
        return quotedString(value2, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value2)) {
        return implicitKey || inFlow || !value2.includes("\n") ? quotedString(value2, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value2.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value2)) {
        if (indent3 === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent3 === indentStep) {
          return quotedString(value2, ctx);
        }
      }
      const str = value2.replace(/\n+/g, `$&
${indent3}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value2, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent3, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports$1.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports$1) {
    var anchors = require_anchors();
    var identity2 = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options3) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options3);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match6 = tags.filter((t) => t.tag === item.tag);
        if (match6.length > 0)
          return match6.find((t) => t.format === item.format) ?? match6[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity2.isScalar(item)) {
        obj = item.value;
        let match6 = tags.filter((t) => t.identify?.(obj));
        if (match6.length > 1) {
          const testMatch = match6.filter((t) => t.test);
          if (testMatch.length > 0)
            match6 = testMatch;
        }
        tagObj = match6.find((t) => t.format === item.format) ?? match6.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity2.isScalar(node) || identity2.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify2(item, ctx, onComment, onChompKeep) {
      if (identity2.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity2.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity2.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity2.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity2.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports$1.createStringifyContext = createStringifyContext;
    exports$1.stringify = stringify2;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports$1) {
    var identity2 = require_identity();
    var Scalar = require_Scalar();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value: value2 }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent: indent3, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity2.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity2.isCollection(key) || !identity2.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value2 == null && !ctx.inFlow || identity2.isCollection(key) || (identity2.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent3 + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify2.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value2 == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value2 == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent3}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity2.isNode(value2)) {
        vsb = !!value2.spaceBefore;
        vcb = value2.commentBefore;
        valueComment = value2.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value2 && typeof value2 === "object")
          value2 = doc.createNode(value2);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity2.isScalar(value2))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity2.isSeq(value2) && !value2.flow && !value2.tag && !value2.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify2.stringify(value2, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity2.isCollection(value2)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value2.flow ?? value2.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports$1.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports$1) {
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports$1.debug = debug;
    exports$1.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports$1) {
    var identity2 = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge3 = {
      identify: (value2) => value2 === MERGE_KEY || typeof value2 === "symbol" && value2.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge3.identify(key) || identity2.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge3.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge3.tag && tag.default);
    function addMergeToJSMap(ctx, map13, value2) {
      value2 = ctx && identity2.isAlias(value2) ? value2.resolve(ctx.doc) : value2;
      if (identity2.isSeq(value2))
        for (const it of value2.items)
          mergeValue(ctx, map13, it);
      else if (Array.isArray(value2))
        for (const it of value2)
          mergeValue(ctx, map13, it);
      else
        mergeValue(ctx, map13, value2);
    }
    function mergeValue(ctx, map13, value2) {
      const source = ctx && identity2.isAlias(value2) ? value2.resolve(ctx.doc) : value2;
      if (!identity2.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value3] of srcMap) {
        if (map13 instanceof Map) {
          if (!map13.has(key))
            map13.set(key, value3);
        } else if (map13 instanceof Set) {
          map13.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map13, key)) {
          Object.defineProperty(map13, key, {
            value: value3,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map13;
    }
    exports$1.addMergeToJSMap = addMergeToJSMap;
    exports$1.isMergeKey = isMergeKey;
    exports$1.merge = merge3;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports$1) {
    var log2 = require_log();
    var merge3 = require_merge();
    var stringify2 = require_stringify();
    var identity2 = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map13, { key, value: value2 }) {
      if (identity2.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map13, value2);
      else if (merge3.isMergeKey(ctx, key))
        merge3.addMergeToJSMap(ctx, map13, value2);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map13 instanceof Map) {
          map13.set(jsKey, toJS.toJS(value2, jsKey, ctx));
        } else if (map13 instanceof Set) {
          map13.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value2, stringKey, ctx);
          if (stringKey in map13)
            Object.defineProperty(map13, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map13[stringKey] = jsValue;
        }
      }
      return map13;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity2.isNode(key) && ctx?.doc) {
        const strCtx = stringify2.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log2.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports$1.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports$1) {
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity2 = require_identity();
    function createPair(key, value2, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value2, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value2 = null) {
        Object.defineProperty(this, identity2.NODE_TYPE, { value: identity2.PAIR });
        this.key = key;
        this.value = value2;
      }
      clone(schema) {
        let { key, value: value2 } = this;
        if (identity2.isNode(key))
          key = key.clone(schema);
        if (identity2.isNode(value2))
          value2 = value2.clone(schema);
        return new _Pair(key, value2);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports$1.Pair = Pair;
    exports$1.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports$1) {
    var identity2 = require_identity();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options3) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify3 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify3(collection, ctx, options3);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent: indent3, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines2 = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity2.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines2.push("");
          addCommentBefore(ctx, lines2, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity2.isPair(item)) {
          const ik = identity2.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines2.push("");
            addCommentBefore(ctx, lines2, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify2.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines2.push(blockItemPrefix + str2);
      }
      let str;
      if (lines2.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines2[0];
        for (let i = 1; i < lines2.length; ++i) {
          const line4 = lines2[i];
          str += line4 ? `
${indent3}${line4}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent3);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent: indent3, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines2 = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity2.isNode(item)) {
          if (item.spaceBefore)
            lines2.push("");
          addCommentBefore(ctx, lines2, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity2.isPair(item)) {
          const ik = identity2.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines2.push("");
            addCommentBefore(ctx, lines2, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity2.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify2.stringify(item, itemCtx, () => comment = null);
        if (i < items.length - 1)
          str += ",";
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        if (!reqNewline && (lines2.length > linesAtValue || str.includes("\n")))
          reqNewline = true;
        lines2.push(str);
        linesAtValue = lines2.length;
      }
      const { start, end } = flowChars;
      if (lines2.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines2.reduce((sum, line4) => sum + line4.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line4 of lines2)
            str += line4 ? `
${indentStep}${indent3}${line4}` : "\n";
          return `${str}
${indent3}${end}`;
        } else {
          return `${start}${fcPadding}${lines2.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent: indent3, options: { commentString } }, lines2, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent3);
        lines2.push(ic.trimStart());
      }
    }
    exports$1.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports$1) {
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity2 = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity2.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity2.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity2.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity2.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map13 = new this(schema);
        const add = (key, value2) => {
          if (typeof replacer === "function")
            value2 = replacer.call(obj, key, value2);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value2 !== void 0 || keepUndefined)
            map13.items.push(Pair.createPair(key, value2, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value2] of obj)
            add(key, value2);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map13.items.sort(schema.sortMapEntries);
        }
        return map13;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity2.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity2.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity2.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value2) {
        this.add(new Pair.Pair(key, value2), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map13 = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map13);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map13, item);
        return map13;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity2.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports$1.YAMLMap = YAMLMap;
    exports$1.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports$1) {
    var identity2 = require_identity();
    var YAMLMap = require_YAMLMap();
    var map13 = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map14, onError) {
        if (!identity2.isMap(map14))
          onError("Expected a mapping for this tag");
        return map14;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports$1.map = map13;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports$1) {
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity2 = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity2.SEQ, schema);
        this.items = [];
      }
      add(value2) {
        this.items.push(value2);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity2.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value2) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity2.isScalar(prev) && Scalar.isScalarValue(value2))
          prev.value = value2;
        else
          this.items[idx] = value2;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity2.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports$1.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports$1) {
    var identity2 = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity2.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports$1.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports$1) {
    var stringifyString = require_stringifyString();
    var string5 = {
      identify: (value2) => typeof value2 === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports$1.string = string5;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports$1) {
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value2) => value2 == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports$1.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports$1) {
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value2) => typeof value2 === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value: value2 }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value2 === sv)
            return source;
        }
        return value2 ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports$1.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports$1) {
    function stringifyNumber({ format, minFractionDigits, tag, value: value2 }) {
      if (typeof value2 === "bigint")
        return String(value2);
      const num = typeof value2 === "number" ? value2 : Number(value2);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value2, -0) ? "-0" : JSON.stringify(value2);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^\d/.test(n)) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports$1.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports$1) {
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value2) => typeof value2 === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value2) => typeof value2 === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float5 = {
      identify: (value2) => typeof value2 === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot3 = str.indexOf(".");
        if (dot3 !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot3 - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports$1.float = float5;
    exports$1.floatExp = floatExp;
    exports$1.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports$1) {
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value2) => typeof value2 === "bigint" || Number.isInteger(value2);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value: value2 } = node;
      if (intIdentify(value2) && value2 >= 0)
        return prefix + value2.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value2) => intIdentify(value2) && value2 >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int2 = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value2) => intIdentify(value2) && value2 >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports$1.int = int2;
    exports$1.intHex = intHex;
    exports$1.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports$1) {
    var map13 = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string5 = require_string();
    var bool = require_bool();
    var float5 = require_float();
    var int2 = require_int();
    var schema = [
      map13.map,
      seq.seq,
      string5.string,
      _null.nullTag,
      bool.boolTag,
      int2.intOct,
      int2.int,
      int2.intHex,
      float5.floatNaN,
      float5.floatExp,
      float5.float
    ];
    exports$1.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports$1) {
    var Scalar = require_Scalar();
    var map13 = require_map();
    var seq = require_seq();
    function intIdentify(value2) {
      return typeof value2 === "bigint" || Number.isInteger(value2);
    }
    var stringifyJSON = ({ value: value2 }) => JSON.stringify(value2);
    var jsonScalars = [
      {
        identify: (value2) => typeof value2 === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value2) => value2 == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value2) => typeof value2 === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value: value2 }) => intIdentify(value2) ? value2.toString() : JSON.stringify(value2)
      },
      {
        identify: (value2) => typeof value2 === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map13.map, seq.seq].concat(jsonScalars, jsonError);
    exports$1.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports$1) {
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value2) => value2 instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value: value2 }, ctx, onComment, onChompKeep) {
        if (!value2)
          return "";
        const buf = value2;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines2 = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines2[i] = str.substr(o, lineWidth);
          }
          str = lines2.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports$1.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports$1) {
    var identity2 = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity2.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity2.isPair(item))
            continue;
          else if (identity2.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity2.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value2;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value2 = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value2 = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value2, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports$1.createPairs = createPairs;
    exports$1.pairs = pairs;
    exports$1.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports$1) {
    var identity2 = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map13 = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map13);
        for (const pair of this.items) {
          let key, value2;
          if (identity2.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value2 = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map13.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map13.set(key, value2);
        }
        return map13;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value2) => value2 instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity2.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports$1.YAMLOMap = YAMLOMap;
    exports$1.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports$1) {
    var Scalar = require_Scalar();
    function boolStringify({ value: value2, source }, ctx) {
      const boolObj = value2 ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value2 ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value2) => value2 === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value2) => value2 === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports$1.falseTag = falseTag;
    exports$1.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports$1) {
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value2) => typeof value2 === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value2) => typeof value2 === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float5 = {
      identify: (value2) => typeof value2 === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot3 = str.indexOf(".");
        if (dot3 !== -1) {
          const f = str.substring(dot3 + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports$1.float = float5;
    exports$1.floatExp = floatExp;
    exports$1.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports$1) {
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value2) => typeof value2 === "bigint" || Number.isInteger(value2);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value: value2 } = node;
      if (intIdentify(value2)) {
        const str = value2.toString(radix);
        return value2 < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int2 = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports$1.int = int2;
    exports$1.intBin = intBin;
    exports$1.intHex = intHex;
    exports$1.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports$1) {
    var identity2 = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity2.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity2.isPair(pair) ? identity2.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value2) {
        if (typeof value2 !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value2}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value2) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value2) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set3 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value2 of iterable) {
            if (typeof replacer === "function")
              value2 = replacer.call(iterable, value2, value2);
            set3.items.push(Pair.createPair(value2, null, ctx));
          }
        return set3;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set2 = {
      collection: "map",
      identify: (value2) => value2 instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map13, onError) {
        if (identity2.isMap(map13)) {
          if (map13.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map13);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map13;
      }
    };
    exports$1.YAMLSet = YAMLSet;
    exports$1.set = set2;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports$1) {
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p3) => res2 * num(60) + num(p3), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value: value2 } = node;
      let num = (n) => n;
      if (typeof value2 === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value2) || !isFinite(value2))
        return stringifyNumber.stringifyNumber(node);
      let sign = "";
      if (value2 < 0) {
        sign = "-";
        value2 *= num(-1);
      }
      const _60 = num(60);
      const parts = [value2 % _60];
      if (value2 < 60) {
        parts.unshift(0);
      } else {
        value2 = (value2 - parts[0]) / _60;
        parts.unshift(value2 % _60);
        if (value2 >= 60) {
          value2 = (value2 - parts[0]) / _60;
          parts.unshift(value2);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value2) => typeof value2 === "bigint" || Number.isInteger(value2),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value2) => typeof value2 === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value2) => value2 instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match6 = str.match(timestamp.test);
        if (!match6)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match6.map(Number);
        const millisec = match6[7] ? Number((match6[7] + "00").substr(1, 3)) : 0;
        let date5 = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match6[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date5 -= 6e4 * d;
        }
        return new Date(date5);
      },
      stringify: ({ value: value2 }) => value2?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports$1.floatTime = floatTime;
    exports$1.intTime = intTime;
    exports$1.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports$1) {
    var map13 = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string5 = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float5 = require_float2();
    var int2 = require_int2();
    var merge3 = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set2 = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map13.map,
      seq.seq,
      string5.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int2.intBin,
      int2.intOct,
      int2.int,
      int2.intHex,
      float5.floatNaN,
      float5.floatExp,
      float5.float,
      binary.binary,
      merge3.merge,
      omap.omap,
      pairs.pairs,
      set2.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports$1.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports$1) {
    var map13 = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string5 = require_string();
    var bool = require_bool();
    var float5 = require_float();
    var int2 = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge3 = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set2 = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map13.map, seq.seq, string5.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float5.float,
      floatExp: float5.floatExp,
      floatNaN: float5.floatNaN,
      floatTime: timestamp.floatTime,
      int: int2.int,
      intHex: int2.intHex,
      intOct: int2.intOct,
      intTime: timestamp.intTime,
      map: map13.map,
      merge: merge3.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set2.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge3.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set2.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge3.merge) ? schemaTags.concat(merge3.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge3.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports$1.coreKnownTags = coreKnownTags;
    exports$1.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports$1) {
    var identity2 = require_identity();
    var map13 = require_map();
    var seq = require_seq();
    var string5 = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge: merge3, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge3);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity2.MAP, { value: map13.map });
        Object.defineProperty(this, identity2.SCALAR, { value: string5.string });
        Object.defineProperty(this, identity2.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports$1.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports$1) {
    var identity2 = require_identity();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options3) {
      const lines2 = [];
      let hasDirectives = options3.directives === true;
      if (options3.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines2.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines2.push("---");
      const ctx = stringify2.createStringifyContext(doc, options3);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines2.length !== 1)
          lines2.unshift("");
        const cs = commentString(doc.commentBefore);
        lines2.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity2.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines2.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines2.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify2.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines2[lines2.length - 1] === "---") {
          lines2[lines2.length - 1] = `--- ${body}`;
        } else
          lines2.push(body);
      } else {
        lines2.push(stringify2.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines2.push("...");
            lines2.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines2.push(`... ${cs}`);
          }
        } else {
          lines2.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines2[lines2.length - 1] !== "")
            lines2.push("");
          lines2.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines2.join("\n") + "\n";
    }
    exports$1.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports$1) {
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity2 = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value2, replacer, options3) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity2.NODE_TYPE, { value: identity2.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options3 === void 0 && replacer) {
          options3 = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options3);
        this.options = opt;
        let { version } = opt;
        if (options3?._directives) {
          this.directives = options3._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options3);
        this.contents = value2 === void 0 ? null : this.createNode(value2, _replacer, options3);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity2.NODE_TYPE]: { value: identity2.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity2.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value2) {
        if (assertCollection(this.contents))
          this.contents.add(value2);
      }
      /** Adds a value to the document. */
      addIn(path2, value2) {
        if (assertCollection(this.contents))
          this.contents.addIn(path2, value2);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value2, replacer, options3) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value2 = replacer.call({ "": value2 }, "", value2);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options3 === void 0 && replacer) {
          options3 = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options3 ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value2, tag, ctx);
        if (flow && identity2.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value2, options3 = {}) {
        const k = this.createNode(key, null, options3);
        const v = this.createNode(value2, null, options3);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path2) {
        if (Collection.isEmptyPath(path2)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path2) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity2.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path2, keepScalar) {
        if (Collection.isEmptyPath(path2))
          return !keepScalar && identity2.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity2.isCollection(this.contents) ? this.contents.getIn(path2, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity2.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path2) {
        if (Collection.isEmptyPath(path2))
          return this.contents !== void 0;
        return identity2.isCollection(this.contents) ? this.contents.hasIn(path2) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value2) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value2);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value2);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path2, value2) {
        if (Collection.isEmptyPath(path2)) {
          this.contents = value2;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path2), value2);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path2, value2);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options3 = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options3.schema instanceof Object)
          this.schema = options3.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options3));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options3 = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options3 && (!Number.isInteger(options3.indent) || Number(options3.indent) <= 0)) {
          const s = JSON.stringify(options3.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options3);
      }
    };
    function assertCollection(contents) {
      if (identity2.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports$1.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports$1) {
    var YAMLError = class extends Error {
      constructor(name, pos, code2, message) {
        super();
        this.name = name;
        this.code = code2;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code2, message) {
        super("YAMLParseError", pos, code2, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code2, message) {
        super("YAMLWarning", pos, code2, message);
      }
    };
    var prettifyError = (src, lc) => (error3) => {
      if (error3.pos[0] === -1)
        return;
      error3.linePos = error3.pos.map((pos) => lc.linePos(pos));
      const { line: line4, col } = error3.linePos[0];
      error3.message += ` at line ${line4}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line4 - 1], lc.lineStarts[line4]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line4 > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line4 - 2], lc.lineStarts[line4 - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error3.linePos[1];
        if (end?.line === line4 && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error3.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports$1.YAMLError = YAMLError;
    exports$1.YAMLParseError = YAMLParseError;
    exports$1.YAMLWarning = YAMLWarning;
    exports$1.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports$1) {
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma3 = null;
      let found = null;
      let start = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start ?? (start = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma3)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma3 = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma: comma3,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports$1.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports$1) {
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports$1.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports$1) {
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent3, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent3 && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports$1.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports$1) {
    var identity2 = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity2.isScalar(a) && identity2.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports$1.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports$1) {
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map13 = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep, value: value2 } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map13.comment)
                map13.comment += "\n" + keyProps.comment;
              else
                map13.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map13.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep ?? [], {
          indicator: "map-value-ind",
          next: value2,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value2?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value2 ? composeNode(ctx, value2, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value2, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map13.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map13.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map13.range = [bm.offset, offset, commentEnd ?? offset];
      return map13;
    }
    exports$1.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports$1) {
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value: value2 } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value2,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value2) {
            if (value2?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value2 ? composeNode(ctx, value2, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value2, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports$1.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports$1) {
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep = "";
        for (const token of end) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep + cb;
              sep = "";
              break;
            }
            case "newline":
              if (comment)
                sep += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports$1.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports$1) {
    var identity2 = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep, value: value2 } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep && !value2) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity2.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep && !props.found) {
          const valueNode = value2 ? composeNode(ctx, value2, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value2))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value2,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep)
                for (const st of sep) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value2) {
            if ("source" in value2 && value2.source?.[0] === ":")
              onError(value2, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value2 ? composeNode(ctx, value2, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value2))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map13 = coll;
            if (utilMapIncludes.mapIncludes(ctx, map13.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map13.items.push(pair);
          } else {
            const map13 = new YAMLMap.YAMLMap(ctx.schema);
            map13.flow = true;
            map13.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map13.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map13);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports$1.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports$1) {
    var identity2 = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity2.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports$1.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports$1) {
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines2 = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines2.length;
      for (let i = lines2.length - 1; i >= 0; --i) {
        const content = lines2[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value3 = header.chomp === "+" && lines2.length > 0 ? "\n".repeat(Math.max(1, lines2.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value3, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent3, content] = lines2[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent3.length > trimIndent)
            trimIndent = indent3.length;
        } else {
          if (indent3.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent3.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent3.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent3.length + content.length + 1;
      }
      for (let i = lines2.length - 1; i >= chompStart; --i) {
        if (lines2[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value2 = "";
      let sep = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value2 += lines2[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent3, content] = lines2[i];
        offset += indent3.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent3.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent3 = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value2 += sep + indent3.slice(trimIndent) + content;
          sep = "\n";
        } else if (indent3.length > trimIndent || content[0] === "	") {
          if (sep === " ")
            sep = "\n";
          else if (!prevMoreIndented && sep === "\n")
            sep = "\n\n";
          value2 += sep + indent3.slice(trimIndent) + content;
          sep = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep === "\n")
            value2 += "\n";
          else
            sep = "\n";
        } else {
          value2 += sep + content;
          sep = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines2.length; ++i)
            value2 += "\n" + lines2[i][0].slice(trimIndent);
          if (value2[value2.length - 1] !== "\n")
            value2 += "\n";
          break;
        default:
          value2 += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value: value2, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent3 = 0;
      let chomp = "";
      let error3 = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent3 && n)
            indent3 = n;
          else if (error3 === -1)
            error3 = offset + i;
        }
      }
      if (error3 !== -1)
        onError(error3, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent: indent3, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first2 = split[0];
      const m = first2.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first2.slice(m[1].length)] : ["", first2];
      const lines2 = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines2.push([split[i], split[i + 1]]);
      return lines2;
    }
    exports$1.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports$1) {
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value2;
      const _onError = (rel, code2, msg) => onError(offset + rel, code2, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value2 = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value2 = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value2 = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value: value2,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first2, line4;
      try {
        first2 = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line4 = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first2 = /(.*?)[ \t]*\r?\n/sy;
        line4 = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match6 = first2.exec(source);
      if (!match6)
        return source;
      let res = match6[1];
      let sep = " ";
      let pos = first2.lastIndex;
      line4.lastIndex = pos;
      while (match6 = line4.exec(source)) {
        if (match6[1] === "") {
          if (sep === "\n")
            res += sep;
          else
            sep = "\n";
        } else {
          res += sep + match6[1];
          sep = " ";
        }
        pos = line4.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match6 = last.exec(source);
      return res + sep + (match6?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = { x: 2, u: 4, U: 8 }[next];
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code2 = ok ? parseInt(cc, 16) : NaN;
      if (isNaN(code2)) {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
      return String.fromCodePoint(code2);
    }
    exports$1.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports$1) {
    var identity2 = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value: value2, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity2.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value2, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value2, token, onError);
      else
        tag = ctx.schema[identity2.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value2, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity2.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error3) {
        const msg = error3 instanceof Error ? error3.message : String(error3);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value2);
      }
      scalar.range = range;
      scalar.source = value2;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value2, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity2.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value2))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity2.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value2, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value2)) || schema[identity2.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value2)) ?? schema[identity2.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports$1.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports$1) {
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports$1.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports$1) {
    var Alias = require_Alias();
    var identity2 = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          node = composeCollection.composeCollection(CN, ctx, token, props, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError);
          isSrcToken = false;
        }
      }
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity2.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options: options3 }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options3.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports$1.composeEmptyNode = composeEmptyNode;
    exports$1.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports$1) {
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options3, directives, { offset, start, value: value2, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options3);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value2 ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value2 && (value2.type === "block-map" || value2.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value2 ? composeNode.composeNode(ctx, value2, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports$1.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports$1) {
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity2 = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options3 = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code2, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code2, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code2, message));
        };
        this.directives = new directives.Directives({ version: options3.version || "1.2" });
        this.options = options3;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity2.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity2.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          Array.prototype.push.apply(doc.errors, this.errors);
          Array.prototype.push.apply(doc.warnings, this.warnings);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error3 = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error3);
            else
              this.doc.errors.push(error3);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports$1.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports$1) {
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code2, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code2, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code2, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value2, context) {
      const { implicitKey = false, indent: indent3, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value: value2 }, {
        implicitKey,
        indent: indent3 > 0 ? " ".repeat(indent3) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent: indent3, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head2 = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent: indent3, source: head2 }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent: indent3, source: "\n" });
          return { type: "block-scalar", offset, indent: indent3, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent: indent3, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent: indent3, source, end };
        default:
          return { type: "scalar", offset, indent: indent3, source, end };
      }
    }
    function setScalarValue(token, value2, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent3 = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent3 === "number")
        indent3 += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value: value2 }, {
        implicitKey: implicitKey || indent3 === null,
        indent: indent3 !== null && indent3 > 0 ? " ".repeat(indent3) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head2 = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head2;
        token.source = body;
      } else {
        const { offset } = token;
        const indent3 = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent: indent3, source: head2 }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent: indent3, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent: indent3, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent3 = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent: indent3, source, end });
        }
      }
    }
    exports$1.createScalarToken = createScalarToken;
    exports$1.resolveAsScalar = resolveAsScalar;
    exports$1.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports$1) {
    var stringify2 = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep, value: value2 }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep)
        for (const st of sep)
          res += st.source;
      if (value2)
        res += stringifyToken(value2);
      return res;
    }
    exports$1.stringify = stringify2;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports$1) {
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path2) => {
      let item = cst;
      for (const [field, index] of path2) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path2) => {
      const parent = visit.itemAtPath(cst, path2.slice(0, -1));
      const field = path2[path2.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path2, item, visitor) {
      let ctrl = visitor(item, path2);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path2.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path2);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path2) : ctrl;
    }
    exports$1.visit = visit;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports$1) {
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports$1.createScalarToken = cstScalar.createScalarToken;
    exports$1.resolveAsScalar = cstScalar.resolveAsScalar;
    exports$1.setScalarValue = cstScalar.setScalarValue;
    exports$1.stringify = cstStringify.stringify;
    exports$1.visit = cstVisit.visit;
    exports$1.BOM = BOM;
    exports$1.DOCUMENT = DOCUMENT;
    exports$1.FLOW_END = FLOW_END;
    exports$1.SCALAR = SCALAR;
    exports$1.isCollection = isCollection;
    exports$1.isScalar = isScalar;
    exports$1.prettyToken = prettyToken;
    exports$1.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports$1) {
    var cst = require_cst();
    function isEmpty8(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent3 = 0;
          while (ch === " ")
            ch = this.buffer[++indent3 + offset];
          if (ch === "\r") {
            const next = this.buffer[indent3 + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent3 + 1;
          }
          return ch === "\n" || indent3 >= this.indentNext || !ch && !this.atEnd ? offset + indent3 : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty8(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line4 = this.getLine();
        if (line4 === null)
          return this.setNext("stream");
        if (line4[0] === cst.BOM) {
          yield* this.pushCount(1);
          line4 = line4.substring(1);
        }
        if (line4[0] === "%") {
          let dirEnd = line4.length;
          let cs = line4.indexOf("#");
          while (cs !== -1) {
            const ch = line4[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line4.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line4[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line4.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line4.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty8(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty8(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty8(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return yield* this.parseBlockStart();
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line4 = this.getLine();
        if (line4 === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line4[n]) {
          case "#":
            yield* this.pushCount(line4.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line4.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent3 = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent3 = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line4 = this.getLine();
        if (line4 === null)
          return this.setNext("flow");
        if (indent3 !== -1 && indent3 < this.indentNext && line4[0] !== "#" || indent3 === 0 && (line4.startsWith("---") || line4.startsWith("...")) && isEmpty8(line4[3])) {
          const atFlowEndMarker = indent3 === this.indentNext - 1 && this.flowLevel === 1 && (line4[0] === "]" || line4[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line4[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line4[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line4.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty8(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty8(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent3 = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent3 += 1;
              break;
            case "\n":
              nl = i2;
              indent3 = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent3 >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent3;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent3 > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty8(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty8(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        switch (this.charAt(0)) {
          case "!":
            return (yield* this.pushTag()) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
          case "&":
            return (yield* this.pushUntil(isNotAnchorChar)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
          case "-":
          // this is an error
          case "?":
          // this is an error outside flow collections
          case ":": {
            const inFlow = this.flowLevel > 0;
            const ch1 = this.charAt(1);
            if (isEmpty8(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
              if (!inFlow)
                this.indentNext = this.indentValue + 1;
              else if (this.flowKey)
                this.flowKey = false;
              return (yield* this.pushCount(1)) + (yield* this.pushSpaces(true)) + (yield* this.pushIndicators());
            }
          }
        }
        return 0;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty8(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports$1.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports$1) {
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports$1.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser2 = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports$1) {
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list4, type) {
      for (let i = 0; i < list4.length; ++i)
        if (list4[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list4) {
      for (let i = 0; i < list4.length; ++i) {
        switch (list4[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                Array.prototype.push.apply(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              Array.prototype.push.apply(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error3) {
        const token = error3 ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep;
          if (scalar.end) {
            sep = scalar.end;
            sep.push(this.sourceToken);
            delete scalar.end;
          } else
            sep = [this.sourceToken];
          const map13 = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map13;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map13) {
        const it = map13.items[map13.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map13.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map13.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map13.indent)) {
                const prev = map13.items[map13.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  Array.prototype.push.apply(end, it.start);
                  end.push(this.sourceToken);
                  map13.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map13.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map13.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map13.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map13.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map13.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map13.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep = it.sep;
                  sep.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map13.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map13.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map13);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map13.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  Array.prototype.push.apply(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep = fc.end.splice(1, fc.end.length);
            sep.push(this.sourceToken);
            const map13 = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map13;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent3) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent3)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports$1.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports$1) {
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log2 = require_log();
    var identity2 = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser2();
    function parseOptions(options3) {
      const prettyErrors = options3.prettyErrors !== false;
      const lineCounter$1 = options3.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options3 = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options3);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options3);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options3 = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options3);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options3);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse8(src, reviver, options3) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options3 === void 0 && reviver && typeof reviver === "object") {
        options3 = reviver;
      }
      const doc = parseDocument(src, options3);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log2.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options3));
    }
    function stringify2(value2, replacer, options3) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options3 === void 0 && replacer) {
        options3 = replacer;
      }
      if (typeof options3 === "string")
        options3 = options3.length;
      if (typeof options3 === "number") {
        const indent3 = Math.round(options3);
        options3 = indent3 < 1 ? void 0 : indent3 > 8 ? { indent: 8 } : { indent: indent3 };
      }
      if (value2 === void 0) {
        const { keepUndefined } = options3 ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity2.isDocument(value2) && !_replacer)
        return value2.toString(options3);
      return new Document.Document(value2, _replacer, options3).toString(options3);
    }
    exports$1.parse = parse8;
    exports$1.parseAllDocuments = parseAllDocuments;
    exports$1.parseDocument = parseDocument;
    exports$1.stringify = stringify2;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports$1) {
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity2 = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser2();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports$1.Composer = composer.Composer;
    exports$1.Document = Document.Document;
    exports$1.Schema = Schema.Schema;
    exports$1.YAMLError = errors.YAMLError;
    exports$1.YAMLParseError = errors.YAMLParseError;
    exports$1.YAMLWarning = errors.YAMLWarning;
    exports$1.Alias = Alias.Alias;
    exports$1.isAlias = identity2.isAlias;
    exports$1.isCollection = identity2.isCollection;
    exports$1.isDocument = identity2.isDocument;
    exports$1.isMap = identity2.isMap;
    exports$1.isNode = identity2.isNode;
    exports$1.isPair = identity2.isPair;
    exports$1.isScalar = identity2.isScalar;
    exports$1.isSeq = identity2.isSeq;
    exports$1.Pair = Pair.Pair;
    exports$1.Scalar = Scalar.Scalar;
    exports$1.YAMLMap = YAMLMap.YAMLMap;
    exports$1.YAMLSeq = YAMLSeq.YAMLSeq;
    exports$1.CST = cst;
    exports$1.Lexer = lexer.Lexer;
    exports$1.LineCounter = lineCounter.LineCounter;
    exports$1.Parser = parser.Parser;
    exports$1.parse = publicApi.parse;
    exports$1.parseAllDocuments = publicApi.parseAllDocuments;
    exports$1.parseDocument = publicApi.parseDocument;
    exports$1.stringify = publicApi.stringify;
    exports$1.visit = visit.visit;
    exports$1.visitAsync = visit.visitAsync;
  }
});

// node_modules/@effect/cli/dist/esm/internal/files.js
var Ini = __toESM(require_ini(), 1);
var Toml = __toESM(require_toml(), 1);
var Yaml = __toESM(require_dist(), 1);
var fileParsers = {
  json: (content) => JSON.parse(content),
  yaml: (content) => Yaml.parse(content),
  yml: (content) => Yaml.parse(content),
  ini: (content) => Ini.parse(content),
  toml: (content) => Toml.parse(content),
  tml: (content) => Toml.parse(content)
};
var read = (path2) => flatMap3(FileSystem, (fs) => matchEffect(fs.readFile(path2), {
  onFailure: (error3) => fail2$1(`Could not read file (${path2}): ${error3}`),
  onSuccess: (content) => succeed([path2, content])
}));
var readString = (path2) => flatMap3(FileSystem, (fs) => matchEffect(fs.readFileString(path2), {
  onFailure: (error3) => fail2$1(`Could not read file (${path2}): ${error3}`),
  onSuccess: (content) => succeed([path2, content])
}));
var parse4 = (path2, content, format) => {
  const parser = fileParsers[format ?? path2.split(".").pop()];
  if (parser === void 0) {
    return fail2$1(`Unsupported file format: ${format}`);
  }
  return try_({
    try: () => parser(content),
    catch: (e) => `Could not parse ${format} file (${path2}): ${e}`
  });
};

// node_modules/@effect/typeclass/dist/esm/internal/Iterable.js
function reduce2(b, f) {
  return function(iterable) {
    if (Array.isArray(iterable)) {
      return iterable.reduce(f, b);
    }
    let result = b;
    for (const n of iterable) {
      result = f(result, n);
    }
    return result;
  };
}
function map4(f) {
  return function(iterable) {
    if (Array.isArray(iterable)) {
      return iterable.map(f);
    }
    return (function* () {
      for (const n of iterable) {
        yield f(n);
      }
    })();
  };
}

// node_modules/@effect/typeclass/dist/esm/Product.js
var struct = (F) => (fields) => {
  const keys = Object.keys(fields);
  return F.imap(F.productAll(keys.map((k) => fields[k])), (values) => {
    const out = {};
    for (let i = 0; i < values.length; i++) {
      out[keys[i]] = values[i];
    }
    return out;
  }, (r) => keys.map((k) => r[k]));
};

// node_modules/@effect/typeclass/dist/esm/Semigroup.js
var make6 = (combine4, combineMany = (self, collection) => reduce2(self, combine4)(collection)) => ({
  combine: combine4,
  combineMany
});
var constant = (a) => make6(() => a, () => a);
var first = () => make6((a) => a, (a) => a);
var imap = /* @__PURE__ */ dual(3, (S, to, from) => make6((self, that) => to(S.combine(from(self), from(that))), (self, collection) => to(S.combineMany(from(self), map4(from)(collection)))));
var product = (self, that) => make6(([xa, xb], [ya, yb]) => [self.combine(xa, ya), that.combine(xb, yb)]);
var productAll = (collection) => {
  return make6((x, y) => {
    const len = Math.min(x.length, y.length);
    const out = [];
    let collectionLength = 0;
    for (const s of collection) {
      if (collectionLength >= len) {
        break;
      }
      out.push(s.combine(x[collectionLength], y[collectionLength]));
      collectionLength++;
    }
    return out;
  });
};
var productMany = (self, collection) => {
  const semigroup = productAll(collection);
  return make6((x, y) => [self.combine(x[0], y[0]), ...semigroup.combine(x.slice(1), y.slice(1))]);
};
var of3 = constant;
var Product = {
  of: of3,
  imap,
  product,
  productMany,
  productAll
};
var array = () => make6((self, that) => self.concat(that));
var struct2 = /* @__PURE__ */ struct(Product);

// node_modules/@effect/typeclass/dist/esm/Monoid.js
var fromSemigroup = (S, empty9) => ({
  combine: S.combine,
  combineMany: S.combineMany,
  empty: empty9,
  combineAll: (collection) => S.combineMany(empty9, collection)
});
var array2 = () => fromSemigroup(array(), []);
var struct3 = (fields) => {
  const empty9 = {};
  for (const k in fields) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) {
      empty9[k] = fields[k].empty;
    }
  }
  return fromSemigroup(struct2(fields), empty9);
};

// node_modules/@effect/printer-ansi/dist/esm/internal/color.js
var black = {
  _tag: "Black"
};
var red = {
  _tag: "Red"
};
var green = {
  _tag: "Green"
};
var magenta = {
  _tag: "Magenta"
};
var cyan = {
  _tag: "Cyan"
};
var white = {
  _tag: "White"
};
var toCode = (color3) => {
  switch (color3._tag) {
    case "Black": {
      return 0;
    }
    case "Red": {
      return 1;
    }
    case "Green": {
      return 2;
    }
    case "Yellow": {
      return 3;
    }
    case "Blue": {
      return 4;
    }
    case "Magenta": {
      return 5;
    }
    case "Cyan": {
      return 6;
    }
    case "White": {
      return 7;
    }
  }
};

// node_modules/@effect/printer-ansi/dist/esm/internal/sgr.js
var reset = {
  _tag: "Reset"
};
var setBold = (bold3) => ({
  _tag: "SetBold",
  bold: bold3
});
var setColor = (color3, vivid, layer) => ({
  _tag: "SetColor",
  color: color3,
  vivid,
  layer
});
var setItalicized = (italicized3) => ({
  _tag: "SetItalicized",
  italicized: italicized3
});
var setStrikethrough = (strikethrough3) => ({
  _tag: "SetStrikethrough",
  strikethrough: strikethrough3
});
var setUnderlined = (underlined3) => ({
  _tag: "SetUnderlined",
  underlined: underlined3
});
var toCode2 = (self) => {
  switch (self._tag) {
    case "Reset": {
      return 0;
    }
    case "SetBold": {
      return self.bold ? 1 : 22;
    }
    case "SetColor": {
      switch (self.layer) {
        case "foreground": {
          return self.vivid ? 90 + toCode(self.color) : 30 + toCode(self.color);
        }
        case "background": {
          return self.vivid ? 100 + toCode(self.color) : 40 + toCode(self.color);
        }
      }
    }
    case "SetItalicized": {
      return self.italicized ? 3 : 23;
    }
    case "SetStrikethrough": {
      return self.strikethrough ? 9 : 29;
    }
    case "SetUnderlined": {
      return self.underlined ? 4 : 24;
    }
  }
};
var toEscapeSequence = (sgrs) => csi("m", sgrs);
var csi = (controlFunction, sgrs) => {
  const params = Array.from(sgrs).map((sgr) => `${toCode2(sgr)}`).join(";");
  return `\x1B[${params}${controlFunction}`;
};

// node_modules/@effect/printer-ansi/dist/esm/internal/ansi.js
var AnsiSymbolKey = "@effect/printer-ansi/Ansi";
var AnsiTypeId = /* @__PURE__ */ Symbol.for(AnsiSymbolKey);
var make7 = (params) => ({
  ...AnsiMonoid.empty,
  ...params
});
var typeIdSemigroup = /* @__PURE__ */ first();
var getFirstSomeSemigroup = /* @__PURE__ */ make6((self, that) => isSome(self) ? self : that);
var AnsiSemigroup = /* @__PURE__ */ struct2({
  [AnsiTypeId]: typeIdSemigroup,
  commands: /* @__PURE__ */ array(),
  foreground: getFirstSomeSemigroup,
  background: getFirstSomeSemigroup,
  bold: getFirstSomeSemigroup,
  italicized: getFirstSomeSemigroup,
  strikethrough: getFirstSomeSemigroup,
  underlined: getFirstSomeSemigroup
});
var typeIdMonoid = /* @__PURE__ */ fromSemigroup(typeIdSemigroup, AnsiTypeId);
var monoidOrElse = /* @__PURE__ */ fromSemigroup(getFirstSomeSemigroup, /* @__PURE__ */ none());
var AnsiMonoid = /* @__PURE__ */ struct3({
  [AnsiTypeId]: typeIdMonoid,
  commands: /* @__PURE__ */ array2(),
  foreground: monoidOrElse,
  background: monoidOrElse,
  bold: monoidOrElse,
  italicized: monoidOrElse,
  strikethrough: monoidOrElse,
  underlined: monoidOrElse
});
var none2 = AnsiMonoid.empty;
var ESC = "\x1B[";
var BEL = "\x07";
var SEP = ";";
var bold = /* @__PURE__ */ make7({
  bold: /* @__PURE__ */ some(/* @__PURE__ */ setBold(true))
});
var italicized = /* @__PURE__ */ make7({
  italicized: /* @__PURE__ */ some(/* @__PURE__ */ setItalicized(true))
});
var strikethrough = /* @__PURE__ */ make7({
  strikethrough: /* @__PURE__ */ some(/* @__PURE__ */ setStrikethrough(true))
});
var underlined = /* @__PURE__ */ make7({
  underlined: /* @__PURE__ */ some(/* @__PURE__ */ setUnderlined(true))
});
var brightColor = (color3) => make7({
  foreground: some(setColor(color3, true, "foreground"))
});
var color = (color3) => make7({
  foreground: some(setColor(color3, false, "foreground"))
});
var black2 = /* @__PURE__ */ color(black);
var red2 = /* @__PURE__ */ color(red);
var green2 = /* @__PURE__ */ color(green);
var white2 = /* @__PURE__ */ color(white);
var blackBright = /* @__PURE__ */ brightColor(black);
var cyanBright = /* @__PURE__ */ brightColor(cyan);
var beep = /* @__PURE__ */ make7({
  commands: /* @__PURE__ */ of(BEL)
});
var cursorTo = (column3, row) => {
  if (row === void 0) {
    const command2 = `${ESC}${Math.max(column3 + 1, 0)}G`;
    return make7({
      commands: of(command2)
    });
  }
  const command = `${ESC}${row + 1}${SEP}${Math.max(column3 + 1, 0)}H`;
  return make7({
    commands: of(command)
  });
};
var cursorMove = (column3, row = 0) => {
  let command = "";
  if (row < 0) {
    command += `${ESC}${-row}A`;
  }
  if (row > 0) {
    command += `${ESC}${row}B`;
  }
  if (column3 > 0) {
    command += `${ESC}${column3}C`;
  }
  if (column3 < 0) {
    command += `${ESC}${-column3}D`;
  }
  return make7({
    commands: of(command)
  });
};
var cursorDown = (lines2 = 1) => {
  const command = `${ESC}${lines2}B`;
  return make7({
    commands: of(command)
  });
};
var cursorLeft = /* @__PURE__ */ make7({
  commands: /* @__PURE__ */ of(`${ESC}G`)
});
var cursorSavePosition = /* @__PURE__ */ make7({
  commands: /* @__PURE__ */ of(`${ESC}s`)
});
var cursorRestorePosition = /* @__PURE__ */ make7({
  commands: /* @__PURE__ */ of(`${ESC}u`)
});
var cursorHide = /* @__PURE__ */ make7({
  commands: /* @__PURE__ */ of(`${ESC}?25l`)
});
var cursorShow = /* @__PURE__ */ make7({
  commands: /* @__PURE__ */ of(`${ESC}?25h`)
});
var eraseLines = (rows) => {
  let command = "";
  for (let i = 0; i < rows; i++) {
    command += `${ESC}2K` + (i < rows - 1 ? `${ESC}1A` : "");
  }
  if (rows > 0) {
    command += `${ESC}G`;
  }
  return make7({
    commands: of(command)
  });
};
var eraseLine = /* @__PURE__ */ make7({
  commands: /* @__PURE__ */ of(`${ESC}2K`)
});
var stringify = (self) => stringifyInternal(self);
var combine2 = /* @__PURE__ */ dual(2, (self, that) => combineInternal(self, that));
var combineInternal = (self, that) => AnsiSemigroup.combine(self, that);
var stringifyInternal = (self) => {
  const displaySequence = toEscapeSequence(getSomes([some(reset), self.foreground, self.background, self.bold, self.italicized, self.strikethrough, self.underlined]));
  const commandSequence = join$1(self.commands, "");
  return `${displaySequence}${commandSequence}`;
};

// node_modules/@effect/printer-ansi/dist/esm/Ansi.js
var bold2 = bold;
var italicized2 = italicized;
var strikethrough2 = strikethrough;
var underlined2 = underlined;
var color2 = color;
var black3 = black2;
var red3 = red2;
var green3 = green2;
var white3 = white2;
var blackBright2 = blackBright;
var cyanBright2 = cyanBright;
var combine3 = combine2;

// node_modules/@effect/printer/dist/esm/internal/flatten.js
var FlattenSymbolKey = "@effect/printer/Flatten";
var FlattenTypeId = /* @__PURE__ */ Symbol.for(FlattenSymbolKey);
var protoHash = {
  Flattened: (self) => combine(hash(self.value))(string(FlattenSymbolKey)),
  AlreadyFlat: (_) => combine(string("@effect/printer/Flattened/AlreadyFlat"))(string(FlattenSymbolKey)),
  NeverFlat: (_) => combine(string("@effect/printer/Flattened/NeverFlat"))(string(FlattenSymbolKey))
};
var protoEqual = {
  Flattened: (self, that) => isFlatten(that) && that._tag === "Flattened" && equals(self.value, that.value),
  AlreadyFlat: (_, that) => isFlatten(that) && that._tag === "AlreadyFlat",
  NeverFlat: (_, that) => isFlatten(that) && that._tag === "NeverFlat"
};
var proto = {
  [FlattenTypeId]: {
    _A: (_) => _
  },
  [symbol]() {
    return cached(this, protoHash[this._tag](this));
  },
  [symbol2](that) {
    return protoEqual[this._tag](this, that);
  }
};
var isFlatten = (u) => typeof u === "object" && u != null && FlattenTypeId in u;
var isFlattened = (self) => self._tag === "Flattened";
var isAlreadyFlat = (self) => self._tag === "AlreadyFlat";
var isNeverFlat = (self) => self._tag === "NeverFlat";
var flattened = (value2) => (() => {
  const op = Object.create(proto);
  op._tag = "Flattened";
  op.value = value2;
  return op;
})();
var alreadyFlat = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto);
  op._tag = "AlreadyFlat";
  return op;
})();
var neverFlat = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto);
  op._tag = "NeverFlat";
  return op;
})();
var map5 = /* @__PURE__ */ dual(2, (self, f) => {
  switch (self._tag) {
    case "Flattened": {
      return flattened(f(self.value));
    }
    case "AlreadyFlat": {
      return alreadyFlat;
    }
    case "NeverFlat": {
      return neverFlat;
    }
  }
});

// node_modules/@effect/printer/dist/esm/internal/doc.js
var DocSymbolKey = "@effect/printer/Doc";
var DocTypeId = /* @__PURE__ */ Symbol.for(DocSymbolKey);
var protoHash2 = {
  Fail: (_) => combine(hash(DocSymbolKey))(hash("@effect/printer/Doc/Fail")),
  Empty: (_) => combine(hash(DocSymbolKey))(hash("@effect/printer/Doc/Empty")),
  Char: (self) => combine(hash(DocSymbolKey))(string(self.char)),
  Text: (self) => combine(hash(DocSymbolKey))(string(self.text)),
  Line: (_) => combine(hash(DocSymbolKey))(hash("@effect/printer/Doc/Line")),
  FlatAlt: (self) => combine(hash(DocSymbolKey))(combine(hash(self.left))(hash(self.right))),
  Cat: (self) => combine(hash(DocSymbolKey))(combine(hash(self.left))(hash(self.right))),
  Nest: (self) => combine(hash(DocSymbolKey))(combine(hash(self.indent))(hash(self.doc))),
  Union: (self) => combine(hash(DocSymbolKey))(combine(hash(self.left))(hash(self.right))),
  Column: (self) => combine(hash(DocSymbolKey))(hash(self.react)),
  WithPageWidth: (self) => combine(hash(DocSymbolKey))(hash(self.react)),
  Nesting: (self) => combine(hash(DocSymbolKey))(hash(self.react)),
  Annotated: (self) => combine(hash(DocSymbolKey))(combine(hash(self.annotation))(hash(self.doc)))
};
var protoEqual2 = {
  Fail: (_, that) => isDoc(that) && that._tag === "Fail",
  Empty: (_, that) => isDoc(that) && that._tag === "Empty",
  Char: (self, that) => isDoc(that) && that._tag === "Char" && self.char === that.char,
  Text: (self, that) => isDoc(that) && that._tag === "Text" && self.text === that.text,
  Line: (_, that) => isDoc(that) && that._tag === "Line",
  FlatAlt: (self, that) => isDoc(that) && that._tag === "FlatAlt" && equals(that.left)(self.left) && equals(that.right)(self.right),
  Cat: (self, that) => isDoc(that) && that._tag === "Cat" && equals(that.left)(self.left) && equals(that.right)(self.right),
  Nest: (self, that) => isDoc(that) && that._tag === "Nest" && self.indent === that.indent && equals(that.doc)(self.doc),
  Union: (self, that) => isDoc(that) && that._tag === "Union" && equals(that.left)(self.left) && equals(that.right)(self.right),
  Column: (self, that) => isDoc(that) && that._tag === "Column" && equals(that.react)(self.react),
  WithPageWidth: (self, that) => isDoc(that) && that._tag === "WithPageWidth" && equals(that.react)(self.react),
  Nesting: (self, that) => isDoc(that) && that._tag === "Nesting" && equals(that.react)(self.react),
  Annotated: (self, that) => isDoc(that) && that._tag === "Annotated" && equals(that.annotation)(self.annotation) && equals(that.doc)(self.doc)
};
var proto2 = {
  [DocTypeId]: {
    _A: (_) => _
  },
  [symbol]() {
    return cached(this, protoHash2[this._tag](this));
  },
  [symbol2](that) {
    return protoEqual2[this._tag](this, that);
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isDoc = (u) => typeof u === "object" && u != null && DocTypeId in u;
var isEmpty2 = (self) => self._tag === "Empty";
var isChar = (self) => self._tag === "Char";
var isText = (self) => self._tag === "Text";
var isCat = (self) => self._tag === "Cat";
var isNest = (self) => self._tag === "Nest";
var char = (char4) => {
  const op = Object.create(proto2);
  op._tag = "Char";
  op.char = char4;
  return op;
};
var text = (text9) => {
  const op = Object.create(proto2);
  op._tag = "Text";
  op.text = text9;
  return op;
};
var flatAlt = /* @__PURE__ */ dual(2, (self, that) => {
  const op = Object.create(proto2);
  op._tag = "FlatAlt";
  op.left = self;
  op.right = that;
  return op;
});
var union = /* @__PURE__ */ dual(2, (self, that) => {
  const op = Object.create(proto2);
  op._tag = "Union";
  op.left = self;
  op.right = that;
  return op;
});
var cat = /* @__PURE__ */ dual(2, (self, that) => {
  const op = Object.create(proto2);
  op._tag = "Cat";
  op.left = self;
  op.right = that;
  return op;
});
var empty3 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto2);
  op._tag = "Empty";
  return op;
})();
var fail2 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto2);
  op._tag = "Fail";
  return op;
})();
var hardLine = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto2);
  op._tag = "Line";
  return op;
})();
var line = /* @__PURE__ */ flatAlt(hardLine, /* @__PURE__ */ char(" "));
var lineBreak = /* @__PURE__ */ flatAlt(hardLine, empty3);
var space = /* @__PURE__ */ char(" ");
var cats = (docs) => group(vcat(docs));
var catWithLine = /* @__PURE__ */ dual(2, (self, that) => cat(self, cat(line, that)));
var catWithLineBreak = /* @__PURE__ */ dual(2, (self, that) => cat(self, cat(lineBreak, that)));
var catWithSpace = /* @__PURE__ */ dual(2, (self, that) => cat(self, cat(space, that)));
var concatWith = /* @__PURE__ */ dual(2, (docs, f) => matchRight(fromIterable(docs), {
  onEmpty: () => empty3,
  onNonEmpty: (init, last) => reduceRight(init, last, (curr, acc) => f(acc, curr))
}));
var vcat = (docs) => concatWith(docs, (left2, right2) => catWithLineBreak(left2, right2));
var hsep = (docs) => concatWith(docs, (left2, right2) => catWithSpace(left2, right2));
var vsep = (docs) => concatWith(docs, (left2, right2) => catWithLine(left2, right2));
var group = (self) => {
  switch (self._tag) {
    case "FlatAlt": {
      const flattened2 = changesUponFlattening(self.right);
      switch (flattened2._tag) {
        case "Flattened": {
          return union(flattened2.value, self.left);
        }
        case "AlreadyFlat": {
          return union(self.right, self.left);
        }
        case "NeverFlat": {
          return self.left;
        }
      }
    }
    case "Union": {
      return self;
    }
    default: {
      const flattened2 = changesUponFlattening(self);
      return isFlattened(flattened2) ? union(flattened2.value, self) : self;
    }
  }
};
var column = (react) => {
  const op = Object.create(proto2);
  op._tag = "Column";
  op.react = react;
  return op;
};
var nesting = (react) => {
  const op = Object.create(proto2);
  op._tag = "Nesting";
  op.react = react;
  return op;
};
var pageWidth = (react) => {
  const op = Object.create(proto2);
  op._tag = "WithPageWidth";
  op.react = react;
  return op;
};
var nest = /* @__PURE__ */ dual(2, (self, indent3) => indent3 === 0 ? self : (() => {
  const op = Object.create(proto2);
  op._tag = "Nest";
  op.indent = indent3;
  op.doc = self;
  return op;
})());
var align = (self) => column((position) => nesting((level) => nest(self, position - level)));
var hang = /* @__PURE__ */ dual(2, (self, indent3) => align(nest(self, indent3)));
var indent = /* @__PURE__ */ dual(2, (self, indent3) => hang(cat(spaces(indent3), self), indent3));
var flatten2 = (self) => runSync(flattenSafe(self));
var flattenSafe = (self) => gen(function* () {
  switch (self._tag) {
    case "Fail": {
      return self;
    }
    case "Empty": {
      return self;
    }
    case "Char": {
      return self;
    }
    case "Text": {
      return self;
    }
    case "Line": {
      return fail2;
    }
    case "FlatAlt": {
      return yield* flattenSafe(self.right);
    }
    case "Cat": {
      const left2 = yield* flattenSafe(self.left);
      const right2 = yield* flattenSafe(self.right);
      return cat(left2, right2);
    }
    case "Nest": {
      const doc = yield* flattenSafe(self.doc);
      return nest(doc, self.indent);
    }
    case "Union": {
      return yield* flattenSafe(self.left);
    }
    case "Column": {
      return column((position) => flatten2(self.react(position)));
    }
    case "WithPageWidth": {
      return pageWidth((pageWidth3) => flatten2(self.react(pageWidth3)));
    }
    case "Nesting": {
      return nesting((level) => flatten2(self.react(level)));
    }
    case "Annotated": {
      const doc = yield* flattenSafe(self.doc);
      return annotate(doc, self.annotation);
    }
  }
});
var changesUponFlattening = (self) => runSync(changesUponFlatteningSafe(self));
var changesUponFlatteningSafe = (self) => gen(function* () {
  switch (self._tag) {
    case "Fail":
    case "Line": {
      return neverFlat;
    }
    case "Empty":
    case "Char":
    case "Text": {
      return alreadyFlat;
    }
    case "FlatAlt": {
      const doc = yield* flattenSafe(self.right);
      return flattened(doc);
    }
    case "Cat": {
      const left2 = yield* changesUponFlatteningSafe(self.left);
      const right2 = yield* changesUponFlatteningSafe(self.right);
      if (isNeverFlat(left2) || isNeverFlat(right2)) {
        return neverFlat;
      }
      if (isFlattened(left2) && isFlattened(right2)) {
        return flattened(cat(left2.value, right2.value));
      }
      if (isFlattened(left2) && isAlreadyFlat(right2)) {
        return flattened(cat(left2.value, self.right));
      }
      if (isAlreadyFlat(left2) && isFlattened(right2)) {
        return flattened(cat(self.left, right2.value));
      }
      if (isAlreadyFlat(left2) && isAlreadyFlat(right2)) {
        return alreadyFlat;
      }
      throw new Error("[BUG]: Doc.changesUponFlattening - unable to flatten a Cat document - please open an issue at https://github.com/IMax153/contentlayer/issues/new");
    }
    case "Nest": {
      return yield* pipe(changesUponFlatteningSafe(self.doc), map3(map5((doc) => nest(doc, self.indent))));
    }
    case "Union": {
      return flattened(self.left);
    }
    case "Column": {
      const doc = column((position) => runSync(flattenSafe(self.react(position))));
      return flattened(doc);
    }
    case "WithPageWidth": {
      const doc = pageWidth((pageWidth3) => runSync(flattenSafe(self.react(pageWidth3))));
      return flattened(doc);
    }
    case "Nesting": {
      const doc = nesting((level) => runSync(flattenSafe(self.react(level))));
      return flattened(doc);
    }
    case "Annotated": {
      return yield* pipe(changesUponFlatteningSafe(self.doc), map3(map5((doc) => annotate(doc, self.annotation))));
    }
  }
});
var annotate = /* @__PURE__ */ dual(2, (self, annotation) => {
  const op = Object.create(proto2);
  op._tag = "Annotated";
  op.doc = self;
  op.annotation = annotation;
  return op;
});
var spaces = (n) => {
  if (n <= 0) {
    return empty3;
  }
  if (n === 1) {
    return char(" ");
  }
  return text(textSpaces(n));
};
var textSpaces = (n) => {
  let s = "";
  for (let i = 0; i < n; i++) {
    s = s += " ";
  }
  return s;
};

// node_modules/@effect/printer/dist/esm/internal/docStream.js
var DocStreamSymbolKey = "@effect/printer/DocStream";
var DocStreamTypeId = /* @__PURE__ */ Symbol.for(DocStreamSymbolKey);
var protoHash3 = {
  FailedStream: (_) => pipe(string("@effect/printer/DocStream/FailedStream"), combine(string(DocStreamSymbolKey))),
  EmptyStream: (_) => pipe(string("@effect/printer/DocStream/EmptyStream"), combine(string(DocStreamSymbolKey))),
  CharStream: (self) => pipe(hash("@effect/printer/DocStream/CharStream"), combine(string(DocStreamSymbolKey)), combine(string(self.char)), combine(hash(self.stream))),
  TextStream: (self) => pipe(string("@effect/printer/DocStream/TextStream"), combine(string(DocStreamSymbolKey)), combine(string(self.text)), combine(hash(self.stream))),
  LineStream: (self) => pipe(string("@effect/printer/DocStream/LineStream"), combine(string(DocStreamSymbolKey)), combine(hash(self.stream))),
  PushAnnotationStream: (self) => pipe(string("@effect/printer/DocStream/PopAnnotationStream"), combine(string(DocStreamSymbolKey)), combine(hash(self.annotation)), combine(hash(self.stream))),
  PopAnnotationStream: (self) => pipe(string("@effect/printer/DocStream/PopAnnotationStream"), combine(string(DocStreamSymbolKey)), combine(hash(self.stream)))
};
var protoEqual3 = {
  FailedStream: (self, that) => isDocStream(that) && that._tag === "FailedStream",
  EmptyStream: (self, that) => isDocStream(that) && that._tag === "EmptyStream",
  CharStream: (self, that) => isDocStream(that) && that._tag === "CharStream" && self.char === that.char && equals(self.stream, that.stream),
  TextStream: (self, that) => isDocStream(that) && that._tag === "TextStream" && self.text === that.text && equals(self.stream, that.stream),
  LineStream: (self, that) => isDocStream(that) && that._tag === "LineStream" && equals(self.stream, that.stream),
  PushAnnotationStream: (self, that) => isDocStream(that) && that._tag === "PushAnnotationStream" && equals(self.annotation, that.annotation) && equals(self.stream, that.stream),
  PopAnnotationStream: (self, that) => isDocStream(that) && that._tag === "PopAnnotationStream" && equals(self.stream, that.stream)
};
var proto3 = {
  [DocStreamTypeId]: {
    _A: (_) => _
  },
  [symbol]() {
    return cached(this, protoHash3[this._tag](this));
  },
  [symbol2](that) {
    return protoEqual3[this._tag](this, that);
  }
};
var isDocStream = (u) => typeof u === "object" && u != null && DocStreamTypeId in u;
var isEmptyStream = (self) => self._tag === "EmptyStream";
var isLineStream = (self) => self._tag === "LineStream";
var failed = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto3);
  op._tag = "FailedStream";
  return op;
})();
var empty4 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto3);
  op._tag = "EmptyStream";
  return op;
})();
var char2 = /* @__PURE__ */ dual(2, (self, char4) => {
  const op = Object.create(proto3);
  op._tag = "CharStream";
  op.char = char4;
  op.stream = self;
  return op;
});
var text2 = /* @__PURE__ */ dual(2, (self, text9) => {
  const op = Object.create(proto3);
  op._tag = "TextStream";
  op.text = text9;
  op.stream = self;
  return op;
});
var line2 = /* @__PURE__ */ dual(2, (self, indentation) => {
  const op = Object.create(proto3);
  op._tag = "LineStream";
  op.indentation = indentation;
  op.stream = self;
  return op;
});
var pushAnnotation = /* @__PURE__ */ dual(2, (self, annotation) => {
  const op = Object.create(proto3);
  op._tag = "PushAnnotationStream";
  op.annotation = annotation;
  op.stream = self;
  return op;
});
var popAnnotation = (stream) => {
  const op = Object.create(proto3);
  op._tag = "PopAnnotationStream";
  op.stream = stream;
  return op;
};

// node_modules/@effect/printer/dist/esm/internal/layoutPipeline.js
var nil = {
  _tag: "Nil"
};
var cons2 = (indent3, document, pipeline) => ({
  _tag: "Cons",
  indent: indent3,
  document,
  pipeline
});
var undoAnnotation = (pipeline) => ({
  _tag: "UndoAnnotation",
  pipeline
});

// node_modules/@effect/printer/dist/esm/internal/pageWidth.js
var PageWidthSymbolKey = "@effect/printer/PageWidth";
var PageWidthTypeId = /* @__PURE__ */ Symbol.for(PageWidthSymbolKey);
var protoHash4 = {
  AvailablePerLine: (self) => pipe(hash("@effect/printer/PageWidth/AvailablePerLine"), combine(hash(PageWidthSymbolKey)), combine(hash(self.lineWidth)), combine(hash(self.ribbonFraction))),
  Unbounded: (_) => pipe(hash("@effect/printer/PageWidth/Unbounded"), combine(hash(PageWidthSymbolKey)))
};
var protoEqual4 = {
  AvailablePerLine: (self, that) => isPageWidth(that) && that._tag === "AvailablePerLine" && self.lineWidth === that.lineWidth && self.ribbonFraction === that.ribbonFraction,
  Unbounded: (self, that) => isPageWidth(that) && that._tag === "Unbounded"
};
var proto4 = {
  [PageWidthTypeId]: PageWidthTypeId,
  [symbol]() {
    return cached(this, protoHash4[this._tag](this));
  },
  [symbol2](that) {
    return protoEqual4[this._tag](this, that);
  }
};
var isPageWidth = (u) => typeof u === "object" && u != null && PageWidthTypeId in u;
var availablePerLine = (lineWidth, ribbonFraction) => {
  const op = Object.create(proto4);
  op._tag = "AvailablePerLine";
  op.lineWidth = lineWidth;
  op.ribbonFraction = ribbonFraction;
  return op;
};
var unbounded = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto4);
  op._tag = "Unbounded";
  return op;
})();
var defaultPageWidth = /* @__PURE__ */ availablePerLine(80, 1);
var remainingWidth = (pageWidth3, ribbonFraction, indentation, currentColumn) => {
  const columnsLeftInLine = pageWidth3 - currentColumn;
  const ribbonWidth = Math.max(0, Math.min(pageWidth3, Math.floor(pageWidth3 * ribbonFraction)));
  const columnsLeftInRibbon = indentation + ribbonWidth - currentColumn;
  return Math.min(columnsLeftInLine, columnsLeftInRibbon);
};

// node_modules/@effect/printer/dist/esm/internal/layout.js
var options = (pageWidth3) => ({
  pageWidth: pageWidth3
});
var wadlerLeijen = /* @__PURE__ */ dual(3, (self, fits, options3) => runSync(wadlerLeijenSafe(cons2(0, self, nil), 0, 0, fits, options3)));
var wadlerLeijenSafe = (self, nestingLevel, currentColumn, fits, options3) => {
  const best = (self2, nl, cc) => gen(function* () {
    switch (self2._tag) {
      case "Nil": {
        return empty4;
      }
      case "Cons": {
        switch (self2.document._tag) {
          case "Fail": {
            return failed;
          }
          case "Empty": {
            return yield* best(self2.pipeline, nl, cc);
          }
          case "Char": {
            const stream = yield* best(self2.pipeline, nl, cc + 1);
            return char2(stream, self2.document.char);
          }
          case "Text": {
            const length = self2.document.text.length;
            const stream = yield* best(self2.pipeline, nl, cc + length);
            return text2(stream, self2.document.text);
          }
          case "Line": {
            const stream = yield* best(self2.pipeline, self2.indent, self2.indent);
            const nextIndent = isEmptyStream(stream) || isLineStream(stream) ? 0 : self2.indent;
            return line2(stream, nextIndent);
          }
          case "FlatAlt": {
            const next = cons2(self2.indent, self2.document.left, self2.pipeline);
            return yield* best(next, nl, cc);
          }
          case "Cat": {
            const inner = cons2(self2.indent, self2.document.right, self2.pipeline);
            const outer = cons2(self2.indent, self2.document.left, inner);
            return yield* best(outer, nl, cc);
          }
          case "Nest": {
            const indent3 = self2.indent + self2.document.indent;
            const next = cons2(indent3, self2.document.doc, self2.pipeline);
            return yield* best(next, nl, cc);
          }
          case "Union": {
            const leftPipeline = cons2(self2.indent, self2.document.left, self2.pipeline);
            const rightPipeline = cons2(self2.indent, self2.document.right, self2.pipeline);
            const left2 = best(leftPipeline, nl, cc);
            const right2 = best(rightPipeline, nl, cc);
            return selectNicer(fits, nl, cc, left2, right2);
          }
          case "Column": {
            const doc = self2.document.react(cc);
            const next = cons2(self2.indent, doc, self2.pipeline);
            return yield* best(next, nl, cc);
          }
          case "WithPageWidth": {
            const doc = self2.document.react(options3.pageWidth);
            const next = cons2(self2.indent, doc, self2.pipeline);
            return yield* best(next, nl, cc);
          }
          case "Nesting": {
            const doc = self2.document.react(self2.indent);
            const next = cons2(self2.indent, doc, self2.pipeline);
            return yield* best(next, nl, cc);
          }
          case "Annotated": {
            const undo = undoAnnotation(self2.pipeline);
            const next = cons2(self2.indent, self2.document.doc, undo);
            const stream = yield* best(next, nl, cc);
            return pushAnnotation(stream, self2.document.annotation);
          }
        }
      }
      case "UndoAnnotation": {
        const stream = yield* best(self2.pipeline, nestingLevel, currentColumn);
        return popAnnotation(stream);
      }
    }
  });
  return best(self, nestingLevel, currentColumn);
};
var selectNicer = (fits, lineIndent, currentColumn, left2, right2) => {
  const leftStream = runSync(left2);
  let rightStream = void 0;
  return fits(leftStream, lineIndent, currentColumn, () => rightStream ?? (rightStream = runSync(right2), rightStream)) ? leftStream : rightStream ?? runSync(right2);
};
var compact = (self) => runSync(compactSafe(of2(self), 0));
var compactSafe = (docs, i) => gen(function* () {
  if (isNil(docs)) {
    return empty4;
  }
  const head2 = docs.head;
  const tail = docs.tail;
  switch (head2._tag) {
    case "Fail": {
      return failed;
    }
    case "Empty": {
      return yield* compactSafe(tail, i);
    }
    case "Char": {
      const stream = yield* compactSafe(tail, i + 1);
      return char2(stream, head2.char);
    }
    case "Text": {
      const stream = yield* compactSafe(tail, i + head2.text.length);
      return text2(stream, head2.text);
    }
    case "Line": {
      const stream = yield* compactSafe(tail, 0);
      return line2(stream, 0);
    }
    case "FlatAlt": {
      return yield* compactSafe(cons(head2.left, tail), i);
    }
    case "Cat": {
      const list4 = cons(head2.left, cons(head2.right, tail));
      return yield* compactSafe(list4, i);
    }
    case "Nest": {
      return yield* compactSafe(cons(head2.doc, tail), i);
    }
    case "Union": {
      return yield* compactSafe(cons(head2.right, tail), i);
    }
    case "Column": {
      return yield* compactSafe(cons(head2.react(i), tail), i);
    }
    case "WithPageWidth": {
      return yield* compactSafe(cons(head2.react(unbounded), tail), i);
    }
    case "Nesting": {
      return yield* compactSafe(cons(head2.react(0), tail), i);
    }
    case "Annotated": {
      return yield* compactSafe(cons(head2.doc, tail), i);
    }
  }
});
var pretty = /* @__PURE__ */ dual(2, (self, options3) => {
  const width3 = options3.pageWidth;
  if (width3._tag === "AvailablePerLine") {
    return wadlerLeijen(self, (stream, indentation, currentColumn) => {
      const remainingWidth2 = remainingWidth(width3.lineWidth, width3.ribbonFraction, indentation, currentColumn);
      return fitsPretty(stream, remainingWidth2);
    }, options3);
  }
  return unbounded2(self);
});
var fitsPretty = (self, width3) => {
  let w = width3;
  let stream = self;
  while (w >= 0) {
    switch (stream._tag) {
      case "FailedStream": {
        return false;
      }
      case "EmptyStream": {
        return true;
      }
      case "CharStream": {
        w = w - 1;
        stream = stream.stream;
        break;
      }
      case "TextStream": {
        w = w - stream.text.length;
        stream = stream.stream;
        break;
      }
      case "LineStream": {
        return true;
      }
      case "PushAnnotationStream": {
        stream = stream.stream;
        break;
      }
      case "PopAnnotationStream": {
        stream = stream.stream;
        break;
      }
    }
  }
  return false;
};
var smart = /* @__PURE__ */ dual(2, (self, options3) => {
  const width3 = options3.pageWidth;
  if (width3._tag === "AvailablePerLine") {
    return wadlerLeijen(self, fitsSmart(width3.lineWidth, width3.ribbonFraction), options3);
  }
  return unbounded2(self);
});
var fitsSmart = (pageWidth3, ribbonFraction) => {
  return (stream, indentation, currentColumn, comparator) => {
    const availableWidth = remainingWidth(pageWidth3, ribbonFraction, indentation, currentColumn);
    return fitsSmartLoop(stream, comparator, pageWidth3, currentColumn, availableWidth);
  };
};
var fitsSmartLoop = (self, comparator, pageWidth3, currentColumn, availableWidth) => {
  let minNestingLevel;
  let stream = self;
  let w = availableWidth;
  while (w >= 0) {
    switch (stream._tag) {
      case "FailedStream": {
        return false;
      }
      case "EmptyStream": {
        return true;
      }
      case "CharStream": {
        w = w - 1;
        stream = stream.stream;
        break;
      }
      case "TextStream": {
        w = w - stream.text.length;
        stream = stream.stream;
        break;
      }
      case "LineStream": {
        if (!minNestingLevel) {
          minNestingLevel = match(getInitialIndentation(comparator()), {
            // Definitely not a hanging layout. Return the same `minNestingLevel` that
            // subsequent lines with the same indentation use
            onNone: () => currentColumn,
            // Could be a (less wide) hanging layout, so take the minimum of the indent
            // and the current column
            onSome: (value2) => Math.min(value2, currentColumn)
          });
        }
        if (minNestingLevel < stream.indentation) {
          return false;
        }
        w = pageWidth3 - stream.indentation;
        stream = stream.stream;
        break;
      }
      case "PushAnnotationStream": {
        stream = stream.stream;
        break;
      }
      case "PopAnnotationStream": {
        stream = stream.stream;
        break;
      }
    }
  }
  return false;
};
var getInitialIndentation = (self) => {
  let stream = self;
  while (stream._tag === "LineStream" || stream._tag === "PushAnnotationStream" || stream._tag === "PopAnnotationStream") {
    if (stream._tag === "LineStream") {
      return some(stream.indentation);
    }
    stream = stream.stream;
  }
  return none();
};
var unbounded2 = (self) => wadlerLeijen(self, (stream) => !failsOnFirstLine(stream), {
  pageWidth: unbounded
});
var failsOnFirstLine = (self) => {
  let stream = self;
  while (1) {
    switch (stream._tag) {
      case "FailedStream": {
        return true;
      }
      case "EmptyStream": {
        return false;
      }
      case "CharStream": {
        stream = stream.stream;
        break;
      }
      case "TextStream": {
        stream = stream.stream;
        break;
      }
      case "LineStream": {
        return false;
      }
      case "PushAnnotationStream": {
        stream = stream.stream;
        break;
      }
      case "PopAnnotationStream": {
        stream = stream.stream;
        break;
      }
    }
  }
  throw new Error("bug");
};

// node_modules/@effect/printer/dist/esm/Doc.js
var char3 = char;
var text3 = text;
var empty5 = empty3;
var hardLine2 = hardLine;
var space2 = space;
var cat2 = cat;
var cats2 = cats;
var hsep2 = hsep;
var vsep2 = vsep;
var nest2 = nest;
var align2 = align;
var indent2 = indent;
var annotate2 = annotate;

// node_modules/@effect/printer-ansi/dist/esm/internal/ansiDoc.js
var beep2 = /* @__PURE__ */ annotate2(empty5, beep);
var cursorTo2 = (column3, row) => annotate2(empty5, cursorTo(column3, row));
var cursorMove2 = (column3, row) => annotate2(empty5, cursorMove(column3, row));
var cursorDown2 = (lines2 = 1) => annotate2(empty5, cursorDown(lines2));
var cursorLeft2 = /* @__PURE__ */ annotate2(empty5, cursorLeft);
var cursorSavePosition2 = /* @__PURE__ */ annotate2(empty5, cursorSavePosition);
var cursorRestorePosition2 = /* @__PURE__ */ annotate2(empty5, cursorRestorePosition);
var cursorHide2 = /* @__PURE__ */ annotate2(empty5, cursorHide);
var cursorShow2 = /* @__PURE__ */ annotate2(empty5, cursorShow);
var eraseLines2 = (rows) => annotate2(empty5, eraseLines(rows));
var eraseLine2 = /* @__PURE__ */ annotate2(empty5, eraseLine);

// node_modules/@effect/printer/dist/esm/PageWidth.js
var defaultPageWidth2 = defaultPageWidth;

// node_modules/@effect/printer/dist/esm/Layout.js
var options2 = options;
var compact2 = compact;
var pretty2 = pretty;
var smart2 = smart;

// node_modules/@effect/printer-ansi/dist/esm/internal/ansiRender.js
var render = /* @__PURE__ */ dual(2, (self, config) => {
  switch (config.style) {
    case "compact": {
      return renderStream(compact2(self));
    }
    case "pretty": {
      const width3 = Object.assign({}, defaultPageWidth2, config.options);
      return renderStream(pretty2(self, options2(width3)));
    }
    case "smart": {
      const width3 = Object.assign({}, defaultPageWidth2, config.options);
      return renderStream(smart2(self, options2(width3)));
    }
  }
});
var renderStream = (self) => runSync(renderSafe(self, of2(none2)));
var unsafePeek = (stack) => {
  if (isNil(stack)) {
    throw new Error("BUG: AnsiRender.unsafePeek - peeked at an empty stack - please report an issue at https://github.com/Effect-TS/printer/issues");
  }
  return stack.head;
};
var unsafePop = (stack) => {
  if (isNil(stack)) {
    throw new Error("BUG: AnsiRender.unsafePop - popped from an empty stack - please report an issue at https://github.com/Effect-TS/printer/issues");
  }
  return [stack.head, stack.tail];
};
var renderSafe = (self, stack) => {
  switch (self._tag) {
    case "FailedStream": {
      return dieMessage("BUG: AnsiRender.renderSafe - attempted to render a failed doc stream - please report an issue at https://github.com/Effect-TS/printer/issues");
    }
    case "EmptyStream": {
      return succeed("");
    }
    case "CharStream": {
      return map3(suspend(() => renderSafe(self.stream, stack)), (rest) => self.char + rest);
    }
    case "TextStream": {
      return map3(suspend(() => renderSafe(self.stream, stack)), (rest) => self.text + rest);
    }
    case "LineStream": {
      let indent3 = "\n";
      for (let i = 0; i < self.indentation; i++) {
        indent3 = indent3 += " ";
      }
      return map3(suspend(() => renderSafe(self.stream, stack)), (rest) => indent3 + rest);
    }
    case "PushAnnotationStream": {
      const currentStyle = unsafePeek(stack);
      const nextStyle = combine2(self.annotation, currentStyle);
      return map3(suspend(() => renderSafe(self.stream, cons(self.annotation, stack))), (rest) => stringify(nextStyle) + rest);
    }
    case "PopAnnotationStream": {
      const [, styles] = unsafePop(stack);
      const nextStyle = unsafePeek(styles);
      return map3(suspend(() => renderSafe(self.stream, styles)), (rest) => stringify(nextStyle) + rest);
    }
  }
};

// node_modules/@effect/printer-ansi/dist/esm/AnsiDoc.js
var beep3 = beep2;
var cursorTo3 = cursorTo2;
var cursorMove3 = cursorMove2;
var cursorDown3 = cursorDown2;
var cursorLeft3 = cursorLeft2;
var cursorSavePosition3 = cursorSavePosition2;
var cursorRestorePosition3 = cursorRestorePosition2;
var cursorHide3 = cursorHide2;
var cursorShow3 = cursorShow2;
var eraseLines3 = eraseLines2;
var eraseLine3 = eraseLine2;
var render2 = render;

// node_modules/@effect/printer/dist/esm/internal/optimize.js
var optimize = /* @__PURE__ */ dual(2, (self, depth) => runSync(optimizeSafe(self, depth)));
var optimizeSafe = (self, depth) => {
  const optimize3 = (self2) => gen(function* () {
    switch (self2._tag) {
      case "Fail":
      case "Empty":
      case "Char":
      case "Text":
      case "Line": {
        return self2;
      }
      case "FlatAlt": {
        const left2 = yield* optimize3(self2.left);
        const right2 = yield* optimize3(self2.right);
        return flatAlt(left2, right2);
      }
      case "Cat": {
        if (isEmpty2(self2.left)) {
          return yield* optimize3(self2.right);
        }
        if (isEmpty2(self2.right)) {
          return yield* optimize3(self2.left);
        }
        if (isChar(self2.left) && isChar(self2.right)) {
          return text(self2.left.char + self2.right.char);
        }
        if (isText(self2.left) && isChar(self2.right)) {
          return text(self2.left.text + self2.right.char);
        }
        if (isChar(self2.left) && isText(self2.right)) {
          return text(self2.left.char + self2.right.text);
        }
        if (isText(self2.left) && isText(self2.right)) {
          return text(self2.left.text + self2.right.text);
        }
        if (isChar(self2.left) && isCat(self2.right) && isChar(self2.right.left) || isChar(self2.left) && isCat(self2.right) && isText(self2.right.left) || isText(self2.left) && isCat(self2.right) && isChar(self2.right.left) || isText(self2.left) && isCat(self2.right) && isText(self2.right.left)) {
          const inner = yield* optimize3(cat(self2.left, self2.right.left));
          return yield* optimize3(cat(inner, self2.right.right));
        }
        if (isCat(self2.left) && isChar(self2.left.right) || isCat(self2.left) && isText(self2.left.right)) {
          const inner = yield* optimize3(cat(self2.left.right, self2.right));
          return yield* optimize3(cat(self2.left.left, inner));
        }
        const left2 = yield* optimize3(self2.left);
        const right2 = yield* optimize3(self2.right);
        return cat(left2, right2);
      }
      case "Nest": {
        if (self2.indent === 0) {
          return yield* optimize3(self2.doc);
        }
        if (isEmpty2(self2.doc) || isChar(self2.doc) || isText(self2.doc)) {
          return self2.doc;
        }
        if (isNest(self2.doc)) {
          const indent3 = self2.indent + self2.doc.indent;
          return yield* optimize3(nest(self2.doc.doc, indent3));
        }
        return nest(yield* optimize3(self2.doc), self2.indent);
      }
      case "Union": {
        const left2 = yield* optimize3(self2.left);
        const right2 = yield* optimize3(self2.right);
        return union(left2, right2);
      }
      case "Column": {
        return depth._tag === "Shallow" ? self2 : column((position) => runSync(optimizeSafe(self2.react(position), depth)));
      }
      case "WithPageWidth": {
        return depth._tag === "Shallow" ? self2 : pageWidth((pageWidth3) => runSync(optimizeSafe(self2.react(pageWidth3), depth)));
      }
      case "Nesting": {
        return depth._tag === "Shallow" ? self2 : nesting((level) => runSync(optimizeSafe(self2.react(level), depth)));
      }
      case "Annotated": {
        return annotate(yield* optimize3(self2.doc), self2.annotation);
      }
    }
  });
  return optimize3(self);
};

// node_modules/@effect/printer/dist/esm/Optimize.js
var Deep = {
  _tag: "Deep"
};
var optimize2 = optimize;

// node_modules/@effect/printer-ansi/dist/esm/Color.js
var red4 = red;
var magenta3 = magenta;
var cyan3 = cyan;
var white4 = white;

// node_modules/@effect/cli/dist/esm/internal/helpDoc/span.js
var text4 = (value2) => ({
  _tag: "Text",
  value: value2
});
var empty6 = /* @__PURE__ */ text4("");
var space3 = /* @__PURE__ */ text4(" ");
var code = (value2) => highlight(value2, white4);
var error2 = (value2) => highlight(value2, red4);
var highlight = (value2, color3) => ({
  _tag: "Highlight",
  value: typeof value2 === "string" ? text4(value2) : value2,
  color: color3
});
var strong = (value2) => ({
  _tag: "Strong",
  value: typeof value2 === "string" ? text4(value2) : value2
});
var weak = (value2) => ({
  _tag: "Weak",
  value: typeof value2 === "string" ? text4(value2) : value2
});
var isText3 = (self) => self._tag === "Text";
var concat = /* @__PURE__ */ dual(2, (self, that) => ({
  _tag: "Sequence",
  left: self,
  right: that
}));
var getText = (self) => {
  switch (self._tag) {
    case "Text":
    case "URI": {
      return self.value;
    }
    case "Highlight":
    case "Weak":
    case "Strong": {
      return getText(self.value);
    }
    case "Sequence": {
      return getText(self.left) + getText(self.right);
    }
  }
};
var spans = (spans2) => {
  const elements = fromIterable(spans2);
  if (isNonEmptyReadonlyArray(elements)) {
    return elements.slice(1).reduce(concat, elements[0]);
  }
  return empty6;
};
var isEmpty4 = (self) => size(self) === 0;
var size = (self) => {
  switch (self._tag) {
    case "Text":
    case "URI": {
      return self.value.length;
    }
    case "Highlight":
    case "Strong":
    case "Weak": {
      return size(self.value);
    }
    case "Sequence": {
      return size(self.left) + size(self.right);
    }
  }
};
var toAnsiDoc = (self) => {
  switch (self._tag) {
    case "Highlight": {
      return annotate2(toAnsiDoc(self.value), color2(self.color));
    }
    case "Sequence": {
      return cat2(toAnsiDoc(self.left), toAnsiDoc(self.right));
    }
    case "Strong": {
      return annotate2(toAnsiDoc(self.value), bold2);
    }
    case "Text": {
      return text3(self.value);
    }
    case "URI": {
      return annotate2(text3(self.value), underlined2);
    }
    case "Weak": {
      return annotate2(toAnsiDoc(self.value), black3);
    }
  }
};

// node_modules/@effect/cli/dist/esm/internal/helpDoc.js
var isEmpty5 = (helpDoc) => helpDoc._tag === "Empty";
var isHeader = (helpDoc) => helpDoc._tag === "Header";
var isParagraph = (helpDoc) => helpDoc._tag === "Paragraph";
var isDescriptionList = (helpDoc) => helpDoc._tag === "DescriptionList";
var empty7 = {
  _tag: "Empty"
};
var sequence = /* @__PURE__ */ dual(2, (self, that) => {
  if (isEmpty5(self)) {
    return that;
  }
  if (isEmpty5(that)) {
    return self;
  }
  return {
    _tag: "Sequence",
    left: self,
    right: that
  };
});
var blocks = (helpDocs) => {
  const elements = fromIterable(helpDocs);
  if (isNonEmptyReadonlyArray(elements)) {
    return elements.slice(1).reduce(sequence, elements[0]);
  }
  return empty7;
};
var getSpan = (self) => isHeader(self) || isParagraph(self) ? self.value : empty6;
var descriptionList = (definitions) => ({
  _tag: "DescriptionList",
  definitions
});
var enumeration = (elements) => ({
  _tag: "Enumeration",
  elements
});
var h1 = (value2) => ({
  _tag: "Header",
  value: typeof value2 === "string" ? text4(value2) : value2,
  level: 1
});
var p = (value2) => ({
  _tag: "Paragraph",
  value: typeof value2 === "string" ? text4(value2) : value2
});
var mapDescriptionList = /* @__PURE__ */ dual(2, (self, f) => isDescriptionList(self) ? descriptionList(map2(self.definitions, ([span2, helpDoc]) => f(span2, helpDoc))) : self);
var toAnsiDoc2 = (self) => optimize2(toAnsiDocInternal(self), Deep);
var toAnsiText = (self) => render2(toAnsiDoc2(self), {
  style: "pretty"
});
var toAnsiDocInternal = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty5;
    }
    case "Header": {
      return pipe(annotate2(toAnsiDoc(self.value), bold2), cat2(hardLine2));
    }
    case "Paragraph": {
      return pipe(toAnsiDoc(self.value), cat2(hardLine2));
    }
    case "DescriptionList": {
      const definitions = self.definitions.map(([span2, doc]) => cats2([annotate2(toAnsiDoc(span2), bold2), empty5, indent2(toAnsiDocInternal(doc), 2)]));
      return vsep2(definitions);
    }
    case "Enumeration": {
      const elements = self.elements.map((doc) => cat2(text3("- "), toAnsiDocInternal(doc)));
      return indent2(vsep2(elements), 2);
    }
    case "Sequence": {
      return vsep2([toAnsiDocInternal(self.left), toAnsiDocInternal(self.right)]);
    }
  }
};

// node_modules/@effect/cli/dist/esm/internal/cliConfig.js
var Tag = /* @__PURE__ */ GenericTag("@effect/cli/CliConfig");
var defaultConfig = {
  isCaseSensitive: false,
  autoCorrectLimit: 2,
  finalCheckBuiltIn: false,
  showAllNames: true,
  showBuiltIns: true,
  showTypes: true
};
var normalizeCase = /* @__PURE__ */ dual(2, (self, text9) => self.isCaseSensitive ? text9 : text9.toLowerCase());

// node_modules/@effect/cli/dist/esm/internal/prompt/action.js
var Action = /* @__PURE__ */ taggedEnum();

// node_modules/@effect/cli/dist/esm/internal/prompt.js
var PromptSymbolKey = "@effect/cli/Prompt";
var PromptTypeId = /* @__PURE__ */ Symbol.for(PromptSymbolKey);
var proto5 = {
  ...CommitPrototype,
  [PromptTypeId]: {
    _Output: (_) => _
  },
  commit() {
    return run(this);
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isPrompt = (u) => typeof u === "object" && u != null && PromptTypeId in u;
var custom = (initialState3, handlers) => {
  const op = Object.create(proto5);
  op._tag = "Loop";
  op.initialState = initialState3;
  op.render = handlers.render;
  op.process = handlers.process;
  op.clear = handlers.clear;
  return op;
};
var map8 = /* @__PURE__ */ dual(2, (self, f) => flatMap4(self, (a) => succeed2(f(a))));
var flatMap4 = /* @__PURE__ */ dual(2, (self, f) => {
  const op = Object.create(proto5);
  op._tag = "OnSuccess";
  op.prompt = self;
  op.onSuccess = f;
  return op;
});
var run = /* @__PURE__ */ fnUntraced(function* (self) {
  const terminal = yield* Terminal;
  const input = yield* terminal.readInput;
  return yield* runWithInput(self, terminal, input);
}, /* @__PURE__ */ mapError(() => new QuitException()), scoped);
var runWithInput = (prompt4, terminal, input) => suspend(() => {
  const op = prompt4;
  switch (op._tag) {
    case "Loop": {
      return runLoop(op, terminal, input);
    }
    case "OnSuccess": {
      return flatMap3(runWithInput(op.prompt, terminal, input), (a) => runWithInput(op.onSuccess(a), terminal, input));
    }
    case "Succeed": {
      return succeed(op.value);
    }
  }
});
var runLoop = /* @__PURE__ */ fnUntraced(function* (loop, terminal, input) {
  let state = isEffect(loop.initialState) ? yield* loop.initialState : loop.initialState;
  let action = Action.NextFrame({
    state
  });
  while (true) {
    const msg = yield* loop.render(state, action);
    yield* orDie(terminal.display(msg));
    const event = yield* input.take;
    action = yield* loop.process(event, state);
    switch (action._tag) {
      case "Beep":
        continue;
      case "NextFrame": {
        yield* orDie(terminal.display(yield* loop.clear(state, action)));
        state = action.state;
        continue;
      }
      case "Submit": {
        yield* orDie(terminal.display(yield* loop.clear(state, action)));
        const msg2 = yield* loop.render(state, action);
        yield* orDie(terminal.display(msg2));
        return action.value;
      }
    }
  }
}, (effect, _, terminal) => ensuring(effect, orDie(terminal.display(render2(cursorShow3, {
  style: "pretty"
})))));
var succeed2 = (value2) => {
  const op = Object.create(proto5);
  op._tag = "Succeed";
  op.value = value2;
  return op;
};

// node_modules/@effect/cli/dist/esm/internal/prompt/ansi-utils.js
var defaultFigures = {
  arrowUp: /* @__PURE__ */ text3("\u2191"),
  arrowDown: /* @__PURE__ */ text3("\u2193"),
  arrowLeft: /* @__PURE__ */ text3("\u2190"),
  arrowRight: /* @__PURE__ */ text3("\u2192"),
  radioOn: /* @__PURE__ */ text3("\u25C9"),
  radioOff: /* @__PURE__ */ text3("\u25EF"),
  checkboxOn: /* @__PURE__ */ text3("\u2612"),
  checkboxOff: /* @__PURE__ */ text3("\u2610"),
  tick: /* @__PURE__ */ text3("\u2714"),
  cross: /* @__PURE__ */ text3("\u2716"),
  ellipsis: /* @__PURE__ */ text3("\u2026"),
  pointerSmall: /* @__PURE__ */ text3("\u203A"),
  line: /* @__PURE__ */ text3("\u2500"),
  pointer: /* @__PURE__ */ text3("\u276F")
};
var windowsFigures = {
  arrowUp: defaultFigures.arrowUp,
  arrowDown: defaultFigures.arrowDown,
  arrowLeft: defaultFigures.arrowLeft,
  arrowRight: defaultFigures.arrowRight,
  radioOn: /* @__PURE__ */ text3("(*)"),
  radioOff: /* @__PURE__ */ text3("( )"),
  checkboxOn: /* @__PURE__ */ text3("[*]"),
  checkboxOff: /* @__PURE__ */ text3("[ ]"),
  tick: /* @__PURE__ */ text3("\u221A"),
  cross: /* @__PURE__ */ text3("\xD7"),
  ellipsis: /* @__PURE__ */ text3("..."),
  pointerSmall: /* @__PURE__ */ text3("\xBB"),
  line: /* @__PURE__ */ text3("\u2500"),
  pointer: /* @__PURE__ */ text3(">")
};
var figures = /* @__PURE__ */ map3(/* @__PURE__ */ sync(() => process.platform === "win32"), (isWindows) => isWindows ? windowsFigures : defaultFigures);
function eraseText(text9, columns) {
  if (columns === 0) {
    return cat2(eraseLine3, cursorTo3(0));
  }
  let rows = 0;
  const lines2 = text9.split(/\r?\n/);
  for (const line4 of lines2) {
    rows += 1 + Math.floor(Math.max(line4.length - 1, 0) / columns);
  }
  return eraseLines3(rows);
}
function lines(prompt4, columns) {
  const lines2 = prompt4.split(/\r?\n/);
  return columns === 0 ? lines2.length : pipe(map2(lines2, (line4) => Math.ceil(line4.length / columns)), reduce(0, (left2, right2) => left2 + right2));
}

// node_modules/@effect/cli/dist/esm/internal/prompt/date.js
var renderBeep = /* @__PURE__ */ render2(beep3, {
  style: "pretty"
});
function handleClear(options3) {
  return (state, _) => {
    return gen(function* () {
      const terminal = yield* Terminal;
      const columns = yield* terminal.columns;
      const resetCurrentLine = cat2(eraseLine3, cursorLeft3);
      const clearError = match(state.error, {
        onNone: () => empty5,
        onSome: (error3) => cursorDown3(lines(error3, columns)).pipe(cat2(eraseText(`
${error3}`, columns)))
      });
      const clearOutput = eraseText(options3.message, columns);
      return clearError.pipe(cat2(clearOutput), cat2(resetCurrentLine), optimize2(Deep), render2({
        style: "pretty",
        options: {
          lineWidth: columns
        }
      }));
    });
  };
}
var NEWLINE_REGEX = /\r?\n/;
function renderError(state, pointer) {
  return match(state.error, {
    onNone: () => empty5,
    onSome: (error3) => {
      const errorLines = error3.split(NEWLINE_REGEX);
      if (isNonEmptyReadonlyArray(errorLines)) {
        const annotateLine = (line4) => annotate2(text3(line4), combine3(italicized2, red3));
        const prefix = cat2(annotate2(pointer, red3), space2);
        const lines2 = map2(errorLines, (str) => annotateLine(str));
        return cursorSavePosition3.pipe(cat2(hardLine2), cat2(prefix), cat2(align2(vsep2(lines2))), cat2(cursorRestorePosition3));
      }
      return empty5;
    }
  });
}
function renderParts(state, submitted = false) {
  return reduce(state.dateParts, empty5, (doc, part, currentIndex) => {
    const partDoc = text3(part.toString());
    if (currentIndex === state.cursor && !submitted) {
      const annotation = combine3(underlined2, cyanBright2);
      return cat2(doc, annotate2(partDoc, annotation));
    }
    return cat2(doc, partDoc);
  });
}
function renderOutput(leadingSymbol, trailingSymbol, parts, options3) {
  const annotateLine = (line4) => annotate2(text3(line4), bold2);
  const prefix = cat2(leadingSymbol, space2);
  return match2(options3.message.split(/\r?\n/), {
    onEmpty: () => hsep2([prefix, trailingSymbol, parts]),
    onNonEmpty: (promptLines) => {
      const lines2 = map2(promptLines, (line4) => annotateLine(line4));
      return prefix.pipe(cat2(nest2(vsep2(lines2), 2)), cat2(space2), cat2(trailingSymbol), cat2(space2), cat2(parts));
    }
  });
}
function renderNextFrame(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const leadingSymbol = annotate2(text3("?"), cyanBright2);
    const trailingSymbol = annotate2(figures2.pointerSmall, blackBright2);
    const parts = renderParts(state);
    const promptMsg = renderOutput(leadingSymbol, trailingSymbol, parts, options3);
    const errorMsg = renderError(state, figures2.pointerSmall);
    return cursorHide3.pipe(cat2(promptMsg), cat2(errorMsg), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderSubmission(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const leadingSymbol = annotate2(figures2.tick, green3);
    const trailingSymbol = annotate2(figures2.ellipsis, blackBright2);
    const parts = renderParts(state, true);
    const promptMsg = renderOutput(leadingSymbol, trailingSymbol, parts, options3);
    return promptMsg.pipe(cat2(hardLine2), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function processUp(state) {
  state.dateParts[state.cursor].increment();
  return Action.NextFrame({
    state: {
      ...state,
      typed: ""
    }
  });
}
function processDown(state) {
  state.dateParts[state.cursor].decrement();
  return Action.NextFrame({
    state: {
      ...state,
      typed: ""
    }
  });
}
function processCursorLeft(state) {
  const previousPart = state.dateParts[state.cursor].previousPart();
  return match(previousPart, {
    onNone: () => Action.Beep(),
    onSome: (previous) => Action.NextFrame({
      state: {
        ...state,
        typed: "",
        cursor: state.dateParts.indexOf(previous)
      }
    })
  });
}
function processCursorRight(state) {
  const nextPart = state.dateParts[state.cursor].nextPart();
  return match(nextPart, {
    onNone: () => Action.Beep(),
    onSome: (next) => Action.NextFrame({
      state: {
        ...state,
        typed: "",
        cursor: state.dateParts.indexOf(next)
      }
    })
  });
}
function processNext(state) {
  const nextPart = state.dateParts[state.cursor].nextPart();
  const cursor = match(nextPart, {
    onNone: () => state.dateParts.findIndex((part) => !part.isToken()),
    onSome: (next) => state.dateParts.indexOf(next)
  });
  return Action.NextFrame({
    state: {
      ...state,
      cursor
    }
  });
}
function defaultProcessor(value2, state) {
  if (/\d/.test(value2)) {
    const typed = state.typed + value2;
    state.dateParts[state.cursor].setValue(typed);
    return Action.NextFrame({
      state: {
        ...state,
        typed
      }
    });
  }
  return Action.Beep();
}
var defaultLocales = {
  months: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  monthsShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  weekdaysShort: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
};
function handleRender(options3) {
  return (state, action) => {
    return Action.$match(action, {
      Beep: () => succeed(renderBeep),
      NextFrame: ({
        state: state2
      }) => renderNextFrame(state2, options3),
      Submit: () => renderSubmission(state, options3)
    });
  };
}
function handleProcess(options3) {
  return (input, state) => {
    switch (input.key.name) {
      case "left": {
        return succeed(processCursorLeft(state));
      }
      case "right": {
        return succeed(processCursorRight(state));
      }
      case "k":
      case "up": {
        return succeed(processUp(state));
      }
      case "j":
      case "down": {
        return succeed(processDown(state));
      }
      case "tab": {
        return succeed(processNext(state));
      }
      case "enter":
      case "return": {
        return match3(options3.validate(state.value), {
          onFailure: (error3) => Action.NextFrame({
            state: {
              ...state,
              error: some(error3)
            }
          }),
          onSuccess: (value2) => Action.Submit({
            value: value2
          })
        });
      }
      default: {
        const value2 = getOrElse(input.input, () => "");
        return succeed(defaultProcessor(value2, state));
      }
    }
  };
}
var date = (options3) => {
  const opts = {
    initial: /* @__PURE__ */ new Date(),
    dateMask: "YYYY-MM-DD HH:mm:ss",
    validate: succeed,
    ...options3,
    locales: {
      ...defaultLocales,
      ...options3.locales
    }
  };
  const dateParts = makeDateParts(opts.dateMask, opts.initial, opts.locales);
  const initialCursorPosition = dateParts.findIndex((part) => !part.isToken());
  const initialState3 = {
    dateParts,
    typed: "",
    cursor: initialCursorPosition,
    value: opts.initial,
    error: none()
  };
  return custom(initialState3, {
    render: handleRender(opts),
    process: handleProcess(opts),
    clear: handleClear(opts)
  });
};
var DATE_PART_REGEX = /\\(.)|"((?:\\["\\]|[^"])+)"|(D[Do]?|d{3,4}|d)|(M{1,4})|(YY(?:YY)?)|([aA])|([Hh]{1,2})|(m{1,2})|(s{1,2})|(S{1,4})|./g;
var regexGroups = {
  1: ({
    token,
    ...opts
  }) => new Token({
    token: token.replace(/\\(.)/g, "$1"),
    ...opts
  }),
  2: (opts) => new Day(opts),
  3: (opts) => new Month(opts),
  4: (opts) => new Year(opts),
  5: (opts) => new Meridiem(opts),
  6: (opts) => new Hours(opts),
  7: (opts) => new Minutes(opts),
  8: (opts) => new Seconds(opts),
  9: (opts) => new Milliseconds(opts)
};
var makeDateParts = (dateMask, date5, locales) => {
  const parts = [];
  let result = null;
  while (result = DATE_PART_REGEX.exec(dateMask)) {
    const match6 = result.shift();
    const index = result.findIndex((group3) => group3 !== void 0);
    if (index in regexGroups) {
      const token = result[index] || match6;
      parts.push(regexGroups[index]({
        token,
        date: date5,
        parts,
        locales
      }));
    } else {
      parts.push(new Token({
        token: result[index] || match6,
        date: date5,
        parts,
        locales
      }));
    }
  }
  const orderedParts = parts.reduce((array3, element) => {
    const lastElement = array3[array3.length - 1];
    if (element.isToken() && lastElement !== void 0 && lastElement.isToken()) {
      lastElement.setValue(element.token);
    } else {
      array3.push(element);
    }
    return array3;
  }, empty());
  parts.splice(0, parts.length, ...orderedParts);
  return parts;
};
var DatePart = class {
  token;
  date;
  parts;
  locales;
  constructor(params) {
    this.token = params.token;
    this.locales = params.locales;
    this.date = params.date || /* @__PURE__ */ new Date();
    this.parts = params.parts || [this];
  }
  /**
   * Returns `true` if this `DatePart` is a `Token`, `false` otherwise.
   */
  isToken() {
    return false;
  }
  /**
   * Retrieves the next date part in the list of parts.
   */
  nextPart() {
    return findFirstIndex(this.parts, (part) => part === this).pipe(flatMap((currentPartIndex) => findFirst(this.parts.slice(currentPartIndex + 1), (part) => !part.isToken())));
  }
  /**
   * Retrieves the previous date part in the list of parts.
   */
  previousPart() {
    return findFirstIndex(this.parts, (part) => part === this).pipe(flatMap((currentPartIndex) => findLast(this.parts.slice(0, currentPartIndex), (part) => !part.isToken())));
  }
  toString() {
    return String(this.date);
  }
};
var Token = class extends DatePart {
  increment() {
  }
  decrement() {
  }
  setValue(value2) {
    this.token = this.token + value2;
  }
  isToken() {
    return true;
  }
  toString() {
    return this.token;
  }
};
var Milliseconds = class extends DatePart {
  increment() {
    this.date.setMilliseconds(this.date.getMilliseconds() + 1);
  }
  decrement() {
    this.date.setMilliseconds(this.date.getMilliseconds() - 1);
  }
  setValue(value2) {
    this.date.setMilliseconds(Number.parseInt(value2.slice(-this.token.length)));
  }
  toString() {
    const millis = `${this.date.getMilliseconds()}`;
    return millis.padStart(4, "0").substring(0, this.token.length);
  }
};
var Seconds = class extends DatePart {
  increment() {
    this.date.setSeconds(this.date.getSeconds() + 1);
  }
  decrement() {
    this.date.setSeconds(this.date.getSeconds() - 1);
  }
  setValue(value2) {
    this.date.setSeconds(Number.parseInt(value2.slice(-2)));
  }
  toString() {
    const seconds = `${this.date.getSeconds()}`;
    return this.token.length > 1 ? seconds.padStart(2, "0") : seconds;
  }
};
var Minutes = class extends DatePart {
  increment() {
    this.date.setMinutes(this.date.getMinutes() + 1);
  }
  decrement() {
    this.date.setMinutes(this.date.getMinutes() - 1);
  }
  setValue(value2) {
    this.date.setMinutes(Number.parseInt(value2.slice(-2)));
  }
  toString() {
    const minutes = `${this.date.getMinutes()}`;
    return this.token.length > 1 ? minutes.padStart(2, "0") : minutes;
  }
};
var Hours = class extends DatePart {
  increment() {
    this.date.setHours(this.date.getHours() + 1);
  }
  decrement() {
    this.date.setHours(this.date.getHours() - 1);
  }
  setValue(value2) {
    this.date.setHours(Number.parseInt(value2.slice(-2)));
  }
  toString() {
    const hours = /h/.test(this.token) ? this.date.getHours() % 12 || 12 : this.date.getHours();
    return this.token.length > 1 ? `${hours}`.padStart(2, "0") : `${hours}`;
  }
};
var Day = class extends DatePart {
  increment() {
    this.date.setDate(this.date.getDate() + 1);
  }
  decrement() {
    this.date.setDate(this.date.getDate() - 1);
  }
  setValue(value2) {
    this.date.setDate(Number.parseInt(value2.slice(-2)));
  }
  toString() {
    const date5 = this.date.getDate();
    const day = this.date.getDay();
    return value(this.token).pipe(when2("DD", () => `${date5}`.padStart(2, "0")), when2("Do", () => `${date5}${this.ordinalIndicator(date5)}`), when2("d", () => `${day + 1}`), when2("ddd", () => this.locales.weekdaysShort[day]), when2("dddd", () => this.locales.weekdays[day]), orElse3(() => `${date5}`));
  }
  ordinalIndicator(day) {
    return value(day % 10).pipe(when2(1, () => "st"), when2(2, () => "nd"), when2(3, () => "rd"), orElse3(() => "th"));
  }
};
var Month = class extends DatePart {
  increment() {
    this.date.setMonth(this.date.getMonth() + 1);
  }
  decrement() {
    this.date.setMonth(this.date.getMonth() - 1);
  }
  setValue(value2) {
    const month = Number.parseInt(value2.slice(-2)) - 1;
    this.date.setMonth(month < 0 ? 0 : month);
  }
  toString() {
    const month = this.date.getMonth();
    return value(this.token.length).pipe(when2(2, () => `${month + 1}`.padStart(2, "0")), when2(3, () => this.locales.monthsShort[month]), when2(4, () => this.locales.months[month]), orElse3(() => `${month + 1}`));
  }
};
var Year = class extends DatePart {
  increment() {
    this.date.setFullYear(this.date.getFullYear() + 1);
  }
  decrement() {
    this.date.setFullYear(this.date.getFullYear() - 1);
  }
  setValue(value2) {
    this.date.setFullYear(Number.parseInt(value2.slice(-4)));
  }
  toString() {
    const year = `${this.date.getFullYear()}`.padStart(4, "0");
    return this.token.length === 2 ? year.substring(-2) : year;
  }
};
var Meridiem = class extends DatePart {
  increment() {
    this.date.setHours((this.date.getHours() + 12) % 24);
  }
  decrement() {
    this.increment();
  }
  setValue(_value) {
  }
  toString() {
    const meridiem = this.date.getHours() > 12 ? "pm" : "am";
    return /A/.test(this.token) ? meridiem.toUpperCase() : meridiem;
  }
};

// node_modules/@effect/cli/dist/esm/internal/prompt/utils.js
var entriesToDisplay = (cursor, total, maxVisible) => {
  const max2 = maxVisible === void 0 ? total : maxVisible;
  let startIndex = Math.min(total - max2, cursor - Math.floor(max2 / 2));
  if (startIndex < 0) {
    startIndex = 0;
  }
  const endIndex = Math.min(startIndex + max2, total);
  return {
    startIndex,
    endIndex
  };
};

// node_modules/@effect/cli/dist/esm/internal/prompt/file.js
var CONFIRM_MESSAGE = "The selected directory contains files. Would you like to traverse the selected directory?";
var Confirm = /* @__PURE__ */ taggedEnum();
var showConfirmation = /* @__PURE__ */ Confirm.$is("Show");
var renderBeep2 = /* @__PURE__ */ render2(beep3, {
  style: "pretty"
});
function resolveCurrentPath(path2, options3) {
  return match(path2, {
    onNone: () => match(options3.startingPath, {
      onNone: () => sync(() => process.cwd()),
      onSome: (path3) => flatMap3(FileSystem, (fs) => (
        // Ensure the user provided starting path exists
        orDie(fs.exists(path3)).pipe(filterOrDieMessage(identity, `The provided starting path '${path3}' does not exist`), as(path3))
      ))
    }),
    onSome: (path3) => succeed(path3)
  });
}
function getFileList(directory3, options3) {
  return gen(function* () {
    const fs = yield* FileSystem;
    const path2 = yield* Path;
    const files = yield* orDie(fs.readDirectory(directory3)).pipe(
      // Always prepend the `".."` option to the file list but allow it
      // to be filtered out if the user so desires
      map3((files2) => ["..", ...files2])
    );
    return yield* filter2(files, (file4) => {
      const result = options3.filter(file4);
      const userDefinedFilter = isEffect(result) ? result : succeed(result);
      const directoryFilter = options3.type === "directory" ? map3(orDie(fs.stat(path2.join(directory3, file4))), (info) => info.type === "Directory") : succeed(true);
      return zipWith(userDefinedFilter, directoryFilter, (a, b) => a && b);
    }, {
      concurrency: files.length
    });
  });
}
function handleClear2(options3) {
  return (state, _) => {
    return gen(function* () {
      const terminal = yield* Terminal;
      const columns = yield* terminal.columns;
      const currentPath = yield* resolveCurrentPath(state.path, options3);
      const text9 = "\n".repeat(Math.min(state.files.length, options3.maxPerPage));
      const clearPath = eraseText(currentPath, columns);
      const message = showConfirmation(state.confirm) ? CONFIRM_MESSAGE : options3.message;
      const clearPrompt = eraseText(`
${message}`, columns);
      const clearOptions = eraseText(text9, columns);
      return clearOptions.pipe(cat2(clearPath), cat2(clearPrompt), optimize2(Deep), render2({
        style: "pretty",
        options: {
          lineWidth: columns
        }
      }));
    });
  };
}
var NEWLINE_REGEX2 = /\r?\n/;
function renderPrompt(confirm2, message, leadingSymbol, trailingSymbol) {
  const annotateLine = (line4) => annotate2(text3(line4), bold2);
  const prefix = cat2(leadingSymbol, space2);
  return match2(message.split(NEWLINE_REGEX2), {
    onEmpty: () => hsep2([prefix, trailingSymbol, confirm2]),
    onNonEmpty: (promptLines) => {
      const lines2 = map2(promptLines, (line4) => annotateLine(line4));
      return prefix.pipe(cat2(nest2(vsep2(lines2), 2)), cat2(space2), cat2(trailingSymbol), cat2(space2), cat2(confirm2));
    }
  });
}
function renderPrefix(state, toDisplay, currentIndex, length, figures2) {
  let prefix = space2;
  if (currentIndex === toDisplay.startIndex && toDisplay.startIndex > 0) {
    prefix = figures2.arrowUp;
  } else if (currentIndex === toDisplay.endIndex - 1 && toDisplay.endIndex < length) {
    prefix = figures2.arrowDown;
  }
  return state.cursor === currentIndex ? figures2.pointer.pipe(annotate2(cyanBright2), cat2(prefix)) : prefix.pipe(cat2(space2));
}
function renderFileName(file4, isSelected) {
  return isSelected ? annotate2(text3(file4), combine3(underlined2, cyanBright2)) : text3(file4);
}
function renderFiles(state, files, figures2, options3) {
  const length = files.length;
  const toDisplay = entriesToDisplay(state.cursor, length, options3.maxPerPage);
  const documents = [];
  for (let index = toDisplay.startIndex; index < toDisplay.endIndex; index++) {
    const isSelected = state.cursor === index;
    const prefix = renderPrefix(state, toDisplay, index, length, figures2);
    const fileName = renderFileName(files[index], isSelected);
    documents.push(cat2(prefix, fileName));
  }
  return vsep2(documents);
}
function renderNextFrame2(state, options3) {
  return gen(function* () {
    const path2 = yield* Path;
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const currentPath = yield* resolveCurrentPath(state.path, options3);
    const selectedPath = state.files[state.cursor];
    const resolvedPath = path2.resolve(currentPath, selectedPath);
    const resolvedPathMsg = figures2.pointerSmall.pipe(cat2(space2), cat2(text3(resolvedPath)), annotate2(blackBright2));
    if (showConfirmation(state.confirm)) {
      const leadingSymbol2 = annotate2(text3("?"), cyanBright2);
      const trailingSymbol2 = annotate2(figures2.pointerSmall, blackBright2);
      const confirm2 = annotate2(text3("(Y/n)"), blackBright2);
      const promptMsg2 = renderPrompt(confirm2, CONFIRM_MESSAGE, leadingSymbol2, trailingSymbol2);
      return cursorHide3.pipe(cat2(promptMsg2), cat2(hardLine2), cat2(resolvedPathMsg), optimize2(Deep), render2({
        style: "pretty",
        options: {
          lineWidth: columns
        }
      }));
    }
    const leadingSymbol = annotate2(figures2.tick, green3);
    const trailingSymbol = annotate2(figures2.ellipsis, blackBright2);
    const promptMsg = renderPrompt(empty5, options3.message, leadingSymbol, trailingSymbol);
    const files = renderFiles(state, state.files, figures2, options3);
    return cursorHide3.pipe(cat2(promptMsg), cat2(hardLine2), cat2(resolvedPathMsg), cat2(hardLine2), cat2(files), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderSubmission2(value2, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const leadingSymbol = annotate2(figures2.tick, green3);
    const trailingSymbol = annotate2(figures2.ellipsis, blackBright2);
    const promptMsg = renderPrompt(empty5, options3.message, leadingSymbol, trailingSymbol);
    return promptMsg.pipe(cat2(space2), cat2(annotate2(text3(value2), white3)), cat2(hardLine2), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function handleRender2(options3) {
  return (_, action) => {
    return Action.$match(action, {
      Beep: () => succeed(renderBeep2),
      NextFrame: ({
        state
      }) => renderNextFrame2(state, options3),
      Submit: ({
        value: value2
      }) => renderSubmission2(value2, options3)
    });
  };
}
function processCursorUp(state) {
  const cursor = state.cursor - 1;
  return succeed(Action.NextFrame({
    state: {
      ...state,
      cursor: cursor < 0 ? state.files.length - 1 : cursor
    }
  }));
}
function processCursorDown(state) {
  return succeed(Action.NextFrame({
    state: {
      ...state,
      cursor: (state.cursor + 1) % state.files.length
    }
  }));
}
function processSelection(state, options3) {
  return gen(function* () {
    const fs = yield* FileSystem;
    const path2 = yield* Path;
    const currentPath = yield* resolveCurrentPath(state.path, options3);
    const selectedPath = state.files[state.cursor];
    const resolvedPath = path2.resolve(currentPath, selectedPath);
    const info = yield* orDie(fs.stat(resolvedPath));
    if (info.type === "Directory") {
      const files = yield* getFileList(resolvedPath, options3);
      const filesWithoutParent = files.filter((file4) => file4 !== "..");
      if (options3.type === "directory" || options3.type === "either") {
        return filesWithoutParent.length === 0 ? Action.Submit({
          value: resolvedPath
        }) : Action.NextFrame({
          state: {
            ...state,
            confirm: Confirm.Show()
          }
        });
      }
      return Action.NextFrame({
        state: {
          cursor: 0,
          files,
          path: some(resolvedPath),
          confirm: Confirm.Hide()
        }
      });
    }
    return Action.Submit({
      value: resolvedPath
    });
  });
}
function handleProcess2(options3) {
  return (input, state) => gen(function* () {
    switch (input.key.name) {
      case "k":
      case "up": {
        return yield* processCursorUp(state);
      }
      case "j":
      case "down":
      case "tab": {
        return yield* processCursorDown(state);
      }
      case "enter":
      case "return": {
        return yield* processSelection(state, options3);
      }
      case "y":
      case "t": {
        if (showConfirmation(state.confirm)) {
          const path2 = yield* Path;
          const currentPath = yield* resolveCurrentPath(state.path, options3);
          const selectedPath = state.files[state.cursor];
          const resolvedPath = path2.resolve(currentPath, selectedPath);
          const files = yield* getFileList(resolvedPath, options3);
          return Action.NextFrame({
            state: {
              cursor: 0,
              files,
              path: some(resolvedPath),
              confirm: Confirm.Hide()
            }
          });
        }
        return Action.Beep();
      }
      case "n":
      case "f": {
        if (showConfirmation(state.confirm)) {
          const path2 = yield* Path;
          const currentPath = yield* resolveCurrentPath(state.path, options3);
          const selectedPath = state.files[state.cursor];
          const resolvedPath = path2.resolve(currentPath, selectedPath);
          return Action.Submit({
            value: resolvedPath
          });
        }
        return Action.Beep();
      }
      default: {
        return Action.Beep();
      }
    }
  });
}
var file = (options3 = {}) => {
  const opts = {
    type: options3.type ?? "file",
    message: options3.message ?? `Choose a file`,
    startingPath: fromNullable(options3.startingPath),
    maxPerPage: options3.maxPerPage ?? 10,
    filter: options3.filter ?? (() => succeed(true))
  };
  const initialState3 = gen(function* () {
    const path2 = none();
    const currentPath = yield* resolveCurrentPath(path2, opts);
    const files = yield* getFileList(currentPath, opts);
    const confirm2 = Confirm.Hide();
    return {
      cursor: 0,
      files,
      path: path2,
      confirm: confirm2
    };
  });
  return custom(initialState3, {
    render: handleRender2(opts),
    process: handleProcess2(opts),
    clear: handleClear2(opts)
  });
};

// node_modules/@effect/cli/dist/esm/internal/prompt/number.js
var parseInt2 = /* @__PURE__ */ NumberFromString.pipe(/* @__PURE__ */ int(), decodeUnknown);
var parseFloat2 = /* @__PURE__ */ decodeUnknown(NumberFromString);
var renderBeep3 = /* @__PURE__ */ render2(beep3, {
  style: "pretty"
});
function handleClear3(options3) {
  return (state, _) => {
    return gen(function* () {
      const terminal = yield* Terminal;
      const columns = yield* terminal.columns;
      const resetCurrentLine = cat2(eraseLine3, cursorLeft3);
      const clearError = match(state.error, {
        onNone: () => empty5,
        onSome: (error3) => cursorDown3(lines(error3, columns)).pipe(cat2(eraseText(`
${error3}`, columns)))
      });
      const clearOutput = eraseText(options3.message, columns);
      return clearError.pipe(cat2(clearOutput), cat2(resetCurrentLine), optimize2(Deep), render2({
        style: "pretty",
        options: {
          lineWidth: columns
        }
      }));
    });
  };
}
function renderInput(state, submitted) {
  const annotation = match(state.error, {
    onNone: () => combine3(underlined2, cyanBright2),
    onSome: () => red3
  });
  const value2 = state.value === "" ? empty5 : text3(`${state.value}`);
  return submitted ? value2 : annotate2(value2, annotation);
}
var NEWLINE_REGEX3 = /\r?\n/;
function renderError2(state, pointer) {
  return match(state.error, {
    onNone: () => empty5,
    onSome: (error3) => match2(error3.split(NEWLINE_REGEX3), {
      onEmpty: () => empty5,
      onNonEmpty: (errorLines) => {
        const annotateLine = (line4) => annotate2(text3(line4), combine3(italicized2, red3));
        const prefix = cat2(annotate2(pointer, red3), space2);
        const lines2 = map2(errorLines, (str) => annotateLine(str));
        return cursorSavePosition3.pipe(cat2(hardLine2), cat2(prefix), cat2(align2(vsep2(lines2))), cat2(cursorRestorePosition3));
      }
    })
  });
}
function renderOutput2(state, leadingSymbol, trailingSymbol, options3, submitted = false) {
  const annotateLine = (line4) => annotate2(text3(line4), bold2);
  const prefix = cat2(leadingSymbol, space2);
  return match2(options3.message.split(/\r?\n/), {
    onEmpty: () => hsep2([prefix, trailingSymbol, renderInput(state, submitted)]),
    onNonEmpty: (promptLines) => {
      const lines2 = map2(promptLines, (line4) => annotateLine(line4));
      return prefix.pipe(cat2(nest2(vsep2(lines2), 2)), cat2(space2), cat2(trailingSymbol), cat2(space2), cat2(renderInput(state, submitted)));
    }
  });
}
function renderNextFrame3(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const leadingSymbol = annotate2(text3("?"), cyanBright2);
    const trailingSymbol = annotate2(figures2.pointerSmall, blackBright2);
    const errorMsg = renderError2(state, figures2.pointerSmall);
    const promptMsg = renderOutput2(state, leadingSymbol, trailingSymbol, options3);
    return promptMsg.pipe(cat2(errorMsg), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderSubmission3(nextState, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const leadingSymbol = annotate2(figures2.tick, green3);
    const trailingSymbol = annotate2(figures2.ellipsis, blackBright2);
    const promptMsg = renderOutput2(nextState, leadingSymbol, trailingSymbol, options3, true);
    return promptMsg.pipe(cat2(hardLine2), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function processBackspace(state) {
  if (state.value.length <= 0) {
    return succeed(Action.Beep());
  }
  const value2 = state.value.slice(0, state.value.length - 1);
  return succeed(Action.NextFrame({
    state: {
      ...state,
      value: value2,
      error: none()
    }
  }));
}
function defaultIntProcessor(state, input) {
  if (state.value.length === 0 && input === "-") {
    return succeed(Action.NextFrame({
      state: {
        ...state,
        value: "-",
        error: none()
      }
    }));
  }
  return match3(parseInt2(state.value + input), {
    onFailure: () => Action.Beep(),
    onSuccess: (value2) => Action.NextFrame({
      state: {
        ...state,
        value: `${value2}`,
        error: none()
      }
    })
  });
}
function defaultFloatProcessor(state, input) {
  if (input === "." && state.value.includes(".")) {
    return succeed(Action.Beep());
  }
  if (state.value.length === 0 && input === "-") {
    return succeed(Action.NextFrame({
      state: {
        ...state,
        value: "-",
        error: none()
      }
    }));
  }
  return match3(parseFloat2(state.value + input), {
    onFailure: () => Action.Beep(),
    onSuccess: (value2) => Action.NextFrame({
      state: {
        ...state,
        value: input === "." ? `${value2}.` : `${value2}`,
        error: none()
      }
    })
  });
}
var initialState = {
  cursor: 0,
  value: "",
  error: /* @__PURE__ */ none()
};
function handleRenderInteger(options3) {
  return (state, action) => {
    return Action.$match(action, {
      Beep: () => succeed(renderBeep3),
      NextFrame: ({
        state: state2
      }) => renderNextFrame3(state2, options3),
      Submit: () => renderSubmission3(state, options3)
    });
  };
}
function handleProcessInteger(options3) {
  return (input, state) => {
    switch (input.key.name) {
      case "backspace": {
        return processBackspace(state);
      }
      case "k":
      case "up": {
        return succeed(Action.NextFrame({
          state: {
            ...state,
            value: state.value === "" || state.value === "-" ? `${options3.incrementBy}` : `${Number.parseInt(state.value) + options3.incrementBy}`,
            error: none()
          }
        }));
      }
      case "j":
      case "down": {
        return succeed(Action.NextFrame({
          state: {
            ...state,
            value: state.value === "" || state.value === "-" ? `-${options3.decrementBy}` : `${Number.parseInt(state.value) - options3.decrementBy}`,
            error: none()
          }
        }));
      }
      case "enter":
      case "return": {
        return matchEffect(parseInt2(state.value), {
          onFailure: () => succeed(Action.NextFrame({
            state: {
              ...state,
              error: some("Must provide an integer value")
            }
          })),
          onSuccess: (n) => match3(options3.validate(n), {
            onFailure: (error3) => Action.NextFrame({
              state: {
                ...state,
                error: some(error3)
              }
            }),
            onSuccess: (value2) => Action.Submit({
              value: value2
            })
          })
        });
      }
      default: {
        const value2 = getOrElse(input.input, () => "");
        return defaultIntProcessor(state, value2);
      }
    }
  };
}
var integer = (options3) => {
  const opts = {
    min: Number.NEGATIVE_INFINITY,
    max: Number.POSITIVE_INFINITY,
    incrementBy: 1,
    decrementBy: 1,
    validate: (n) => {
      if (n < opts.min) {
        return fail2$1(`${n} must be greater than or equal to ${opts.min}`);
      }
      if (n > opts.max) {
        return fail2$1(`${n} must be less than or equal to ${opts.max}`);
      }
      return succeed(n);
    },
    ...options3
  };
  return custom(initialState, {
    render: handleRenderInteger(opts),
    process: handleProcessInteger(opts),
    clear: handleClear3(opts)
  });
};
function handleRenderFloat(options3) {
  return (state, action) => {
    return Action.$match(action, {
      Beep: () => succeed(renderBeep3),
      NextFrame: ({
        state: state2
      }) => renderNextFrame3(state2, options3),
      Submit: () => renderSubmission3(state, options3)
    });
  };
}
function handleProcessFloat(options3) {
  return (input, state) => {
    switch (input.key.name) {
      case "backspace": {
        return processBackspace(state);
      }
      case "k":
      case "up": {
        return succeed(Action.NextFrame({
          state: {
            ...state,
            value: state.value === "" || state.value === "-" ? `${options3.incrementBy}` : `${Number.parseFloat(state.value) + options3.incrementBy}`,
            error: none()
          }
        }));
      }
      case "j":
      case "down": {
        return succeed(Action.NextFrame({
          state: {
            ...state,
            value: state.value === "" || state.value === "-" ? `-${options3.decrementBy}` : `${Number.parseFloat(state.value) - options3.decrementBy}`,
            error: none()
          }
        }));
      }
      case "enter":
      case "return": {
        return matchEffect(parseFloat2(state.value), {
          onFailure: () => succeed(Action.NextFrame({
            state: {
              ...state,
              error: some("Must provide a floating point value")
            }
          })),
          onSuccess: (n) => flatMap3(sync(() => round(n, options3.precision)), (rounded) => match3(options3.validate(rounded), {
            onFailure: (error3) => Action.NextFrame({
              state: {
                ...state,
                error: some(error3)
              }
            }),
            onSuccess: (value2) => Action.Submit({
              value: value2
            })
          }))
        });
      }
      default: {
        const value2 = getOrElse(input.input, () => "");
        return defaultFloatProcessor(state, value2);
      }
    }
  };
}
var float = (options3) => {
  const opts = {
    min: Number.NEGATIVE_INFINITY,
    max: Number.POSITIVE_INFINITY,
    incrementBy: 1,
    decrementBy: 1,
    precision: 2,
    validate: (n) => {
      if (n < opts.min) {
        return fail2$1(`${n} must be greater than or equal to ${opts.min}`);
      }
      if (n > opts.max) {
        return fail2$1(`${n} must be less than or equal to ${opts.max}`);
      }
      return succeed(n);
    },
    ...options3
  };
  return custom(initialState, {
    render: handleRenderFloat(opts),
    process: handleProcessFloat(opts),
    clear: handleClear3(opts)
  });
};

// node_modules/@effect/cli/dist/esm/internal/prompt/select.js
var renderBeep4 = /* @__PURE__ */ render2(beep3, {
  style: "pretty"
});
var NEWLINE_REGEX4 = /\r?\n/;
function renderOutput3(leadingSymbol, trailingSymbol, options3) {
  const annotateLine = (line4) => annotate2(text3(line4), bold2);
  const prefix = cat2(leadingSymbol, space2);
  return match2(options3.message.split(NEWLINE_REGEX4), {
    onEmpty: () => hsep2([prefix, trailingSymbol]),
    onNonEmpty: (promptLines) => {
      const lines2 = map2(promptLines, (line4) => annotateLine(line4));
      return prefix.pipe(cat2(nest2(vsep2(lines2), 2)), cat2(space2), cat2(trailingSymbol), cat2(space2));
    }
  });
}
function renderChoicePrefix(state, choices, toDisplay, currentIndex, figures2) {
  let prefix = space2;
  if (currentIndex === toDisplay.startIndex && toDisplay.startIndex > 0) {
    prefix = figures2.arrowUp;
  } else if (currentIndex === toDisplay.endIndex - 1 && toDisplay.endIndex < choices.length) {
    prefix = figures2.arrowDown;
  }
  if (choices[currentIndex].disabled) {
    const annotation = combine3(bold2, blackBright2);
    return state === currentIndex ? figures2.pointer.pipe(annotate2(annotation), cat2(prefix)) : prefix.pipe(cat2(space2));
  }
  return state === currentIndex ? figures2.pointer.pipe(annotate2(cyanBright2), cat2(prefix)) : prefix.pipe(cat2(space2));
}
function renderChoiceTitle(choice4, isSelected) {
  const title = text3(choice4.title);
  if (isSelected) {
    return choice4.disabled ? annotate2(title, combine3(underlined2, blackBright2)) : annotate2(title, combine3(underlined2, cyanBright2));
  }
  return choice4.disabled ? annotate2(title, combine3(strikethrough2, blackBright2)) : title;
}
function renderChoiceDescription(choice4, isSelected) {
  if (!choice4.disabled && choice4.description && isSelected) {
    return char3("-").pipe(cat2(space2), cat2(text3(choice4.description)), annotate2(blackBright2));
  }
  return empty5;
}
function renderChoices(state, options3, figures2) {
  const choices = options3.choices;
  const toDisplay = entriesToDisplay(state, choices.length, options3.maxPerPage);
  const documents = [];
  for (let index = toDisplay.startIndex; index < toDisplay.endIndex; index++) {
    const choice4 = choices[index];
    const isSelected = state === index;
    const prefix = renderChoicePrefix(state, choices, toDisplay, index, figures2);
    const title = renderChoiceTitle(choice4, isSelected);
    const description = renderChoiceDescription(choice4, isSelected);
    documents.push(prefix.pipe(cat2(title), cat2(space2), cat2(description)));
  }
  return vsep2(documents);
}
function renderNextFrame4(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const choices = renderChoices(state, options3, figures2);
    const leadingSymbol = annotate2(text3("?"), cyanBright2);
    const trailingSymbol = annotate2(figures2.pointerSmall, blackBright2);
    const promptMsg = renderOutput3(leadingSymbol, trailingSymbol, options3);
    return cursorHide3.pipe(cat2(promptMsg), cat2(hardLine2), cat2(choices), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderSubmission4(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const selected = text3(options3.choices[state].title);
    const leadingSymbol = annotate2(figures2.tick, green3);
    const trailingSymbol = annotate2(figures2.ellipsis, blackBright2);
    const promptMsg = renderOutput3(leadingSymbol, trailingSymbol, options3);
    return promptMsg.pipe(cat2(space2), cat2(annotate2(selected, white3)), cat2(hardLine2), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function processCursorUp2(state, choices) {
  if (state === 0) {
    return succeed(Action.NextFrame({
      state: choices.length - 1
    }));
  }
  return succeed(Action.NextFrame({
    state: state - 1
  }));
}
function processCursorDown2(state, choices) {
  if (state === choices.length - 1) {
    return succeed(Action.NextFrame({
      state: 0
    }));
  }
  return succeed(Action.NextFrame({
    state: state + 1
  }));
}
function processNext2(state, choices) {
  return succeed(Action.NextFrame({
    state: (state + 1) % choices.length
  }));
}
function handleRender3(options3) {
  return (state, action) => {
    return Action.$match(action, {
      Beep: () => succeed(renderBeep4),
      NextFrame: ({
        state: state2
      }) => renderNextFrame4(state2, options3),
      Submit: () => renderSubmission4(state, options3)
    });
  };
}
function handleClear4(options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const clearPrompt = cat2(eraseLine3, cursorLeft3);
    const text9 = "\n".repeat(Math.min(options3.choices.length, options3.maxPerPage)) + options3.message;
    const clearOutput = eraseText(text9, columns);
    return clearOutput.pipe(cat2(clearPrompt), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function handleProcess3(options3) {
  return (input, state) => {
    switch (input.key.name) {
      case "k":
      case "up": {
        return processCursorUp2(state, options3.choices);
      }
      case "j":
      case "down": {
        return processCursorDown2(state, options3.choices);
      }
      case "tab": {
        return processNext2(state, options3.choices);
      }
      case "enter":
      case "return": {
        const selected = options3.choices[state];
        if (selected.disabled) {
          return succeed(Action.Beep());
        }
        return succeed(Action.Submit({
          value: selected.value
        }));
      }
      default: {
        return succeed(Action.Beep());
      }
    }
  };
}
var select = (options3) => {
  const opts = {
    maxPerPage: 10,
    ...options3
  };
  let initialIndex = 0;
  let seenSelected = -1;
  for (let i = 0; i < opts.choices.length; i++) {
    const choice4 = opts.choices[i];
    if (choice4.selected === true) {
      if (seenSelected !== -1) {
        throw new Error("InvalidArgumentException: only a single choice can be selected by default for Prompt.select");
      }
      seenSelected = i;
    }
  }
  if (seenSelected !== -1) {
    initialIndex = seenSelected;
  }
  return custom(initialIndex, {
    render: handleRender3(opts),
    process: handleProcess3(opts),
    clear: () => handleClear4(opts)
  });
};

// node_modules/@effect/cli/dist/esm/internal/prompt/text.js
function getValue(state, options3) {
  return state.value.length > 0 ? state.value : options3.default;
}
var renderBeep5 = /* @__PURE__ */ render2(beep3, {
  style: "pretty"
});
function renderClearScreen(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const resetCurrentLine = cat2(eraseLine3, cursorLeft3);
    const clearError = match(state.error, {
      onNone: () => empty5,
      onSome: (error3) => (
        // If there was an error, move the cursor down to the final error line and
        // then clear all lines of error output
        cursorDown3(lines(error3, columns)).pipe(
          // Add a leading newline to the error message to ensure that the corrrect
          // number of error lines are erased
          cat2(eraseText(`
${error3}`, columns))
        )
      )
    });
    const inputValue = state.value.length > 0 ? state.value : options3.default;
    const fullLine = `? ${options3.message} \u203A ${inputValue}`;
    const clearOutput = eraseText(fullLine, columns);
    return clearError.pipe(cat2(clearOutput), cat2(resetCurrentLine), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderInput2(nextState, options3, submitted) {
  const text9 = getValue(nextState, options3);
  const annotation = match(nextState.error, {
    onNone: () => {
      if (submitted) {
        return white3;
      }
      if (nextState.value.length === 0) {
        return blackBright2;
      }
      return combine3(underlined2, cyanBright2);
    },
    onSome: () => red3
  });
  switch (options3.type) {
    case "hidden": {
      return empty5;
    }
    case "password": {
      return annotate2(text3("*".repeat(text9.length)), annotation);
    }
    case "text": {
      return annotate2(text3(text9), annotation);
    }
  }
}
function renderError3(nextState, pointer) {
  return match(nextState.error, {
    onNone: () => empty5,
    onSome: (error3) => match2(error3.split(/\r?\n/), {
      onEmpty: () => empty5,
      onNonEmpty: (errorLines) => {
        const annotateLine = (line4) => text3(line4).pipe(annotate2(combine3(italicized2, red3)));
        const prefix = cat2(annotate2(pointer, red3), space2);
        const lines2 = map2(errorLines, (str) => annotateLine(str));
        return cursorSavePosition3.pipe(cat2(hardLine2), cat2(prefix), cat2(align2(vsep2(lines2))), cat2(cursorRestorePosition3));
      }
    })
  });
}
function renderOutput4(nextState, leadingSymbol, trailingSymbol, options3, submitted = false) {
  const annotateLine = (line4) => annotate2(text3(line4), bold2);
  const promptLines = options3.message.split(/\r?\n/);
  const prefix = cat2(leadingSymbol, space2);
  if (isNonEmptyReadonlyArray(promptLines)) {
    const lines2 = map2(promptLines, (line4) => annotateLine(line4));
    return prefix.pipe(cat2(nest2(vsep2(lines2), 2)), cat2(space2), cat2(trailingSymbol), cat2(space2), cat2(renderInput2(nextState, options3, submitted)));
  }
  return hsep2([prefix, trailingSymbol, renderInput2(nextState, options3, submitted)]);
}
function renderNextFrame5(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const leadingSymbol = annotate2(text3("?"), cyanBright2);
    const trailingSymbol = annotate2(figures2.pointerSmall, blackBright2);
    const promptMsg = renderOutput4(state, leadingSymbol, trailingSymbol, options3);
    const errorMsg = renderError3(state, figures2.pointerSmall);
    const offset = state.cursor - state.value.length;
    return promptMsg.pipe(cat2(errorMsg), cat2(cursorMove3(offset)), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderSubmission5(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const figures2 = yield* figures;
    const leadingSymbol = annotate2(figures2.tick, green3);
    const trailingSymbol = annotate2(figures2.ellipsis, blackBright2);
    const promptMsg = renderOutput4(state, leadingSymbol, trailingSymbol, options3, true);
    return promptMsg.pipe(cat2(hardLine2), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function processBackspace2(state) {
  if (state.cursor <= 0) {
    return succeed(Action.Beep());
  }
  const beforeCursor = state.value.slice(0, state.cursor - 1);
  const afterCursor = state.value.slice(state.cursor);
  const cursor = state.cursor - 1;
  const value2 = `${beforeCursor}${afterCursor}`;
  return succeed(Action.NextFrame({
    state: {
      ...state,
      cursor,
      value: value2,
      error: none()
    }
  }));
}
function processCursorLeft2(state) {
  if (state.cursor <= 0) {
    return succeed(Action.Beep());
  }
  const cursor = state.cursor - 1;
  return succeed(Action.NextFrame({
    state: {
      ...state,
      cursor,
      error: none()
    }
  }));
}
function processCursorRight2(state) {
  if (state.cursor >= state.value.length) {
    return succeed(Action.Beep());
  }
  const cursor = Math.min(state.cursor + 1, state.value.length);
  return succeed(Action.NextFrame({
    state: {
      ...state,
      cursor,
      error: none()
    }
  }));
}
function processTab(state, options3) {
  if (state.value === options3.default) {
    return succeed(Action.Beep());
  }
  const value2 = getValue(state, options3);
  const cursor = value2.length;
  return succeed(Action.NextFrame({
    state: {
      ...state,
      value: value2,
      cursor,
      error: none()
    }
  }));
}
function defaultProcessor2(input, state) {
  const beforeCursor = state.value.slice(0, state.cursor);
  const afterCursor = state.value.slice(state.cursor);
  const value2 = `${beforeCursor}${input}${afterCursor}`;
  const cursor = state.cursor + input.length;
  return succeed(Action.NextFrame({
    state: {
      ...state,
      cursor,
      value: value2,
      error: none()
    }
  }));
}
var initialState2 = {
  cursor: 0,
  value: "",
  error: /* @__PURE__ */ none()
};
function handleRender4(options3) {
  return (state, action) => {
    return Action.$match(action, {
      Beep: () => succeed(renderBeep5),
      NextFrame: ({
        state: state2
      }) => renderNextFrame5(state2, options3),
      Submit: () => renderSubmission5(state, options3)
    });
  };
}
function handleProcess4(options3) {
  return (input, state) => {
    switch (input.key.name) {
      case "backspace": {
        return processBackspace2(state);
      }
      case "left": {
        return processCursorLeft2(state);
      }
      case "right": {
        return processCursorRight2(state);
      }
      case "enter":
      case "return": {
        const value2 = getValue(state, options3);
        return match3(options3.validate(value2), {
          onFailure: (error3) => Action.NextFrame({
            state: {
              ...state,
              value: value2,
              error: some(error3)
            }
          }),
          onSuccess: (value3) => Action.Submit({
            value: value3
          })
        });
      }
      case "tab": {
        return processTab(state, options3);
      }
      default: {
        const value2 = getOrElse(input.input, () => "");
        return defaultProcessor2(value2, state);
      }
    }
  };
}
function handleClear5(options3) {
  return (state, _) => {
    return renderClearScreen(state, options3);
  };
}
function basePrompt(options3, type) {
  const opts = {
    default: "",
    type,
    validate: succeed,
    ...options3
  };
  return custom(initialState2, {
    render: handleRender4(opts),
    process: handleProcess4(opts),
    clear: handleClear5(opts)
  });
}
var hidden = (options3) => basePrompt(options3, "hidden").pipe(map8(make7$1));
var text5 = (options3) => basePrompt(options3, "text");

// node_modules/@effect/cli/dist/esm/internal/prompt/toggle.js
var renderBeep6 = /* @__PURE__ */ render2(beep3, {
  style: "pretty"
});
function handleClear6(options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const columns = yield* terminal.columns;
    const clearPrompt = cat2(eraseLine3, cursorLeft3);
    const clearOutput = eraseText(options3.message, columns);
    return clearOutput.pipe(cat2(clearPrompt), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderToggle(value2, options3, submitted = false) {
  const separator = annotate2(char3("/"), blackBright2);
  const selectedAnnotation = combine3(underlined2, submitted ? white3 : cyanBright2);
  const inactive = value2 ? text3(options3.inactive) : annotate2(text3(options3.inactive), selectedAnnotation);
  const active = value2 ? annotate2(text3(options3.active), selectedAnnotation) : text3(options3.active);
  return hsep2([active, separator, inactive]);
}
function renderOutput5(toggle2, leadingSymbol, trailingSymbol, options3) {
  const annotateLine = (line4) => annotate2(text3(line4), bold2);
  const promptLines = options3.message.split(/\r?\n/);
  const prefix = cat2(leadingSymbol, space2);
  if (isNonEmptyReadonlyArray(promptLines)) {
    const lines2 = map2(promptLines, (line4) => annotateLine(line4));
    return prefix.pipe(cat2(nest2(vsep2(lines2), 2)), cat2(space2), cat2(trailingSymbol), cat2(space2), cat2(toggle2));
  }
  return hsep2([prefix, trailingSymbol, toggle2]);
}
function renderNextFrame6(state, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const figures2 = yield* figures;
    const columns = yield* terminal.columns;
    const leadingSymbol = annotate2(text3("?"), cyanBright2);
    const trailingSymbol = annotate2(figures2.pointerSmall, blackBright2);
    const toggle2 = renderToggle(state, options3);
    const promptMsg = renderOutput5(toggle2, leadingSymbol, trailingSymbol, options3);
    return cursorHide3.pipe(cat2(promptMsg), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
function renderSubmission6(value2, options3) {
  return gen(function* () {
    const terminal = yield* Terminal;
    const figures2 = yield* figures;
    const columns = yield* terminal.columns;
    const leadingSymbol = annotate2(figures2.tick, green3);
    const trailingSymbol = annotate2(figures2.ellipsis, blackBright2);
    const toggle2 = renderToggle(value2, options3, true);
    const promptMsg = renderOutput5(toggle2, leadingSymbol, trailingSymbol, options3);
    return promptMsg.pipe(cat2(hardLine2), optimize2(Deep), render2({
      style: "pretty",
      options: {
        lineWidth: columns
      }
    }));
  });
}
var activate = /* @__PURE__ */ succeed(/* @__PURE__ */ Action.NextFrame({
  state: true
}));
var deactivate = /* @__PURE__ */ succeed(/* @__PURE__ */ Action.NextFrame({
  state: false
}));
function handleRender5(options3) {
  return (state, action) => {
    switch (action._tag) {
      case "Beep": {
        return succeed(renderBeep6);
      }
      case "NextFrame": {
        return renderNextFrame6(state, options3);
      }
      case "Submit": {
        return renderSubmission6(state, options3);
      }
    }
  };
}
function handleProcess5(input, state) {
  switch (input.key.name) {
    case "0":
    case "j":
    case "delete":
    case "right":
    case "down": {
      return deactivate;
    }
    case "1":
    case "k":
    case "left":
    case "up": {
      return activate;
    }
    case " ":
    case "tab": {
      return state ? deactivate : activate;
    }
    case "enter":
    case "return": {
      return succeed(Action.Submit({
        value: state
      }));
    }
    default: {
      return succeed(Action.Beep());
    }
  }
}
var toggle = (options3) => {
  const opts = {
    initial: false,
    active: "on",
    inactive: "off",
    ...options3
  };
  return custom(opts.initial, {
    render: handleRender5(opts),
    process: handleProcess5,
    clear: () => handleClear6(opts)
  });
};

// node_modules/@effect/cli/dist/esm/internal/primitive.js
var PrimitiveSymbolKey = "@effect/cli/Primitive";
var PrimitiveTypeId = /* @__PURE__ */ Symbol.for(PrimitiveSymbolKey);
var proto6 = {
  [PrimitiveTypeId]: {
    _A: (_) => _
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isPrimitive = (u) => typeof u === "object" && u != null && PrimitiveTypeId in u;
var isBool = (self) => isPrimitive(self) && isBoolType(self);
var isBoolType = (self) => self._tag === "Bool";
var trueValues = /* @__PURE__ */ Literal("true", "1", "y", "yes", "on");
var isTrueValue = /* @__PURE__ */ is(trueValues);
var falseValues = /* @__PURE__ */ Literal("false", "0", "n", "no", "off");
var isFalseValue = /* @__PURE__ */ is(falseValues);
var boolean2 = (defaultValue) => {
  const op = Object.create(proto6);
  op._tag = "Bool";
  op.defaultValue = defaultValue;
  return op;
};
var choice = (alternatives) => {
  const op = Object.create(proto6);
  op._tag = "Choice";
  op.alternatives = alternatives;
  return op;
};
var date2 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto6);
  op._tag = "DateTime";
  return op;
})();
var float2 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto6);
  op._tag = "Float";
  return op;
})();
var integer2 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto6);
  op._tag = "Integer";
  return op;
})();
var path = (pathType, pathExists) => {
  const op = Object.create(proto6);
  op._tag = "Path";
  op.pathType = pathType;
  op.pathExists = pathExists;
  return op;
};
var redacted = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto6);
  op._tag = "Redacted";
  return op;
})();
var secret = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto6);
  op._tag = "Secret";
  return op;
})();
var text6 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto6);
  op._tag = "Text";
  return op;
})();
var getChoices = (self) => getChoicesInternal(self);
var getHelp = (self) => getHelpInternal(self);
var getTypeName = (self) => getTypeNameInternal(self);
var validate = /* @__PURE__ */ dual(3, (self, value2, config) => validateInternal(self, value2, config));
var wizard = /* @__PURE__ */ dual(2, (self, help) => wizardInternal(self, help));
var getChoicesInternal = (self) => {
  switch (self._tag) {
    case "Bool": {
      return some("true | false");
    }
    case "Choice": {
      const choices = pipe(map2(self.alternatives, ([choice4]) => choice4), join$1(" | "));
      return some(choices);
    }
    case "DateTime": {
      return some("date");
    }
    case "Float":
    case "Integer":
    case "Path":
    case "Redacted":
    case "Secret":
    case "Text": {
      return none();
    }
  }
};
var getHelpInternal = (self) => {
  switch (self._tag) {
    case "Bool": {
      return text4("A true or false value.");
    }
    case "Choice": {
      const choices = pipe(map2(self.alternatives, ([choice4]) => choice4), join$1(", "));
      return text4(`One of the following: ${choices}`);
    }
    case "DateTime": {
      return text4("A date without a time-zone in the ISO-8601 format, such as 2007-12-03T10:15:30.");
    }
    case "Float": {
      return text4("A floating point number.");
    }
    case "Integer": {
      return text4("An integer.");
    }
    case "Path": {
      if (self.pathType === "either" && self.pathExists === "yes") {
        return text4("An existing file or directory.");
      }
      if (self.pathType === "file" && self.pathExists === "yes") {
        return text4("An existing file.");
      }
      if (self.pathType === "directory" && self.pathExists === "yes") {
        return text4("An existing directory.");
      }
      if (self.pathType === "either" && self.pathExists === "no") {
        return text4("A file or directory that must not exist.");
      }
      if (self.pathType === "file" && self.pathExists === "no") {
        return text4("A file that must not exist.");
      }
      if (self.pathType === "directory" && self.pathExists === "no") {
        return text4("A directory that must not exist.");
      }
      if (self.pathType === "either" && self.pathExists === "either") {
        return text4("A file or directory.");
      }
      if (self.pathType === "file" && self.pathExists === "either") {
        return text4("A file.");
      }
      if (self.pathType === "directory" && self.pathExists === "either") {
        return text4("A directory.");
      }
      throw new Error(`[BUG]: Path.help - encountered invalid combination of path type ('${self.pathType}') and path existence ('${self.pathExists}')`);
    }
    case "Secret":
    case "Redacted": {
      return text4("A user-defined piece of text that is confidential.");
    }
    case "Text": {
      return text4("A user-defined piece of text.");
    }
  }
};
var getTypeNameInternal = (self) => {
  switch (self._tag) {
    case "Bool": {
      return "boolean";
    }
    case "Choice": {
      return "choice";
    }
    case "DateTime": {
      return "date";
    }
    case "Float": {
      return "float";
    }
    case "Integer": {
      return "integer";
    }
    case "Path": {
      if (self.pathType === "either") {
        return "path";
      }
      return self.pathType;
    }
    case "Redacted": {
      return "redacted";
    }
    case "Secret": {
      return "secret";
    }
    case "Text": {
      return "text";
    }
  }
};
var validateInternal = (self, value2, config) => {
  switch (self._tag) {
    case "Bool": {
      return map(value2, (str) => normalizeCase(config, str)).pipe(match({
        onNone: () => orElseFail(self.defaultValue, () => `Missing default value for boolean parameter`),
        onSome: (value3) => isTrueValue(value3) ? succeed(true) : isFalseValue(value3) ? succeed(false) : fail2$1(`Unable to recognize '${value3}' as a valid boolean`)
      }));
    }
    case "Choice": {
      return orElseFail(value2, () => `Choice options to not have a default value`).pipe(flatMap3((value3) => findFirst(self.alternatives, ([choice4]) => choice4 === value3)), mapBoth({
        onFailure: () => {
          const choices = pipe(map2(self.alternatives, ([choice4]) => choice4), join$1(", "));
          return `Expected one of the following cases: ${choices}`;
        },
        onSuccess: ([, value3]) => value3
      }));
    }
    case "DateTime": {
      return attempt(value2, getTypeNameInternal(self), decodeUnknown(Date$));
    }
    case "Float": {
      return attempt(value2, getTypeNameInternal(self), decodeUnknown(NumberFromString));
    }
    case "Integer": {
      const intFromString = compose(NumberFromString, Int);
      return attempt(value2, getTypeNameInternal(self), decodeUnknown(intFromString));
    }
    case "Path": {
      return flatMap3(FileSystem, (fileSystem) => {
        const errorMsg = "Path options do not have a default value";
        return orElseFail(value2, () => errorMsg).pipe(tap((path2) => orDie(fileSystem.exists(path2)).pipe(tap((pathExists) => validatePathExistence(path2, self.pathExists, pathExists).pipe(zipRight(validatePathType(path2, self.pathType, fileSystem).pipe(when(() => self.pathExists !== "no" && pathExists))))))));
      });
    }
    case "Redacted": {
      return attempt(value2, getTypeNameInternal(self), decodeUnknown(String$)).pipe(map3((value3) => make7$1(value3)));
    }
    case "Secret": {
      return attempt(value2, getTypeNameInternal(self), decodeUnknown(String$)).pipe(map3((value3) => fromString(value3)));
    }
    case "Text": {
      return attempt(value2, getTypeNameInternal(self), decodeUnknown(String$));
    }
  }
};
var attempt = (option, typeName, parse8) => orElseFail(option, () => `${typeName} options do not have a default value`).pipe(flatMap3((value2) => orElseFail(parse8(value2), () => `'${value2}' is not a ${typeName}`)));
var validatePathExistence = (path2, shouldPathExist, pathExists) => {
  if (shouldPathExist === "no" && pathExists) {
    return fail2$1(`Path '${path2}' must not exist`);
  }
  if (shouldPathExist === "yes" && !pathExists) {
    return fail2$1(`Path '${path2}' must exist`);
  }
  return _void;
};
var validatePathType = (path2, pathType, fileSystem) => {
  switch (pathType) {
    case "file": {
      const checkIsFile = fileSystem.stat(path2).pipe(map3((info) => info.type === "File"), orDie);
      return fail2$1(`Expected path '${path2}' to be a regular file`).pipe(unlessEffect(checkIsFile), asVoid);
    }
    case "directory": {
      const checkIsDirectory = fileSystem.stat(path2).pipe(map3((info) => info.type === "Directory"), orDie);
      return fail2$1(`Expected path '${path2}' to be a directory`).pipe(unlessEffect(checkIsDirectory), asVoid);
    }
    case "either": {
      return _void;
    }
  }
};
var wizardInternal = (self, help) => {
  switch (self._tag) {
    case "Bool": {
      const primitiveHelp = p("Select true or false");
      const message = sequence(help, primitiveHelp);
      const initial = getOrElse(self.defaultValue, () => false);
      return toggle({
        message: toAnsiText(message).trimEnd(),
        initial,
        active: "true",
        inactive: "false"
      }).pipe(map8((bool) => `${bool}`));
    }
    case "Choice": {
      const primitiveHelp = p("Select one of the following choices");
      const message = sequence(help, primitiveHelp);
      return select({
        message: toAnsiText(message).trimEnd(),
        choices: map2(self.alternatives, ([title]) => ({
          title,
          value: title
        }))
      });
    }
    case "DateTime": {
      const primitiveHelp = p("Enter a date");
      const message = sequence(help, primitiveHelp);
      return date({
        message: toAnsiText(message).trimEnd()
      }).pipe(map8((date5) => date5.toISOString()));
    }
    case "Float": {
      const primitiveHelp = p("Enter a floating point value");
      const message = sequence(help, primitiveHelp);
      return float({
        message: toAnsiText(message).trimEnd()
      }).pipe(map8((value2) => `${value2}`));
    }
    case "Integer": {
      const primitiveHelp = p("Enter an integer");
      const message = sequence(help, primitiveHelp);
      return integer({
        message: toAnsiText(message).trimEnd()
      }).pipe(map8((value2) => `${value2}`));
    }
    case "Path": {
      const primitiveHelp = p("Select a file system path");
      const message = sequence(help, primitiveHelp);
      return file({
        type: self.pathType,
        message: toAnsiText(message).trimEnd()
      });
    }
    case "Redacted": {
      const primitiveHelp = p("Enter some text (value will be redacted)");
      const message = sequence(help, primitiveHelp);
      return hidden({
        message: toAnsiText(message).trimEnd()
      });
    }
    case "Secret": {
      const primitiveHelp = p("Enter some text (value will be redacted)");
      const message = sequence(help, primitiveHelp);
      return hidden({
        message: toAnsiText(message).trimEnd()
      });
    }
    case "Text": {
      const primitiveHelp = p("Enter some text");
      const message = sequence(help, primitiveHelp);
      return text5({
        message: toAnsiText(message).trimEnd()
      });
    }
  }
};
var getBashCompletions = (self) => {
  switch (self._tag) {
    case "Bool": {
      return '"${cur}"';
    }
    case "DateTime":
    case "Float":
    case "Integer":
    case "Secret":
    case "Redacted":
    case "Text": {
      return '$(compgen -f "${cur}")';
    }
    case "Path": {
      switch (self.pathType) {
        case "file": {
          return self.pathExists === "yes" || self.pathExists === "either" ? '$(compgen -f "${cur}")' : "";
        }
        case "directory": {
          return self.pathExists === "yes" || self.pathExists === "either" ? '$(compgen -d "${cur}")' : "";
        }
        case "either": {
          return self.pathExists === "yes" || self.pathExists === "either" ? '$(compgen -f "${cur}")' : "";
        }
      }
    }
    case "Choice": {
      const choices = pipe(map2(self.alternatives, ([choice4]) => choice4), join$1(","));
      return `$(compgen -W "${choices}" -- "\${cur}")`;
    }
  }
};
var getFishCompletions = (self) => {
  switch (self._tag) {
    case "Bool": {
      return empty();
    }
    case "DateTime":
    case "Float":
    case "Integer":
    case "Redacted":
    case "Secret":
    case "Text": {
      return make("-r", "-f");
    }
    case "Path": {
      switch (self.pathType) {
        case "file": {
          return self.pathExists === "yes" || self.pathExists === "either" ? make("-r", "-F") : make("-r");
        }
        case "directory": {
          return self.pathExists === "yes" || self.pathExists === "either" ? make("-r", "-f", "-a", `"(__fish_complete_directories (commandline -ct))"`) : make("-r");
        }
        case "either": {
          return self.pathExists === "yes" || self.pathExists === "either" ? make("-r", "-F") : make("-r");
        }
      }
    }
    case "Choice": {
      const choices = pipe(map2(self.alternatives, ([choice4]) => `${choice4}''`), join$1(","));
      return make("-r", "-f", "-a", `"{${choices}}"`);
    }
  }
};
var getZshCompletions = (self) => {
  switch (self._tag) {
    case "Bool": {
      return "";
    }
    case "Choice": {
      const choices = pipe(map2(self.alternatives, ([name]) => name), join$1(" "));
      return `:CHOICE:(${choices})`;
    }
    case "DateTime": {
      return "";
    }
    case "Float": {
      return "";
    }
    case "Integer": {
      return "";
    }
    case "Path": {
      switch (self.pathType) {
        case "file": {
          return self.pathExists === "yes" || self.pathExists === "either" ? ":PATH:_files" : "";
        }
        case "directory": {
          return self.pathExists === "yes" || self.pathExists === "either" ? ":PATH:_files -/" : "";
        }
        case "either": {
          return self.pathExists === "yes" || self.pathExists === "either" ? ":PATH:_files" : "";
        }
      }
    }
    case "Redacted":
    case "Secret":
    case "Text": {
      return "";
    }
  }
};

// node_modules/@effect/cli/dist/esm/internal/usage.js
var empty8 = {
  _tag: "Empty"
};
var mixed = {
  _tag: "Empty"
};
var named = (names, acceptedValues) => ({
  _tag: "Named",
  names,
  acceptedValues
});
var optional = (self) => ({
  _tag: "Optional",
  usage: self
});
var repeated = (self) => ({
  _tag: "Repeated",
  usage: self
});
var alternation = /* @__PURE__ */ dual(2, (self, that) => ({
  _tag: "Alternation",
  left: self,
  right: that
}));
var concat2 = /* @__PURE__ */ dual(2, (self, that) => ({
  _tag: "Concat",
  left: self,
  right: that
}));
var getHelp2 = (self) => {
  const spans2 = enumerate(self, defaultConfig);
  if (isNonEmptyReadonlyArray(spans2)) {
    const head2 = headNonEmpty(spans2);
    const tail = tailNonEmpty(spans2);
    if (isNonEmptyReadonlyArray(tail)) {
      return pipe(map2(spans2, (span2) => p(span2)), reduceRight(empty7, (left2, right2) => sequence(left2, right2)));
    }
    return p(head2);
  }
  return empty7;
};
var enumerate = /* @__PURE__ */ dual(2, (self, config) => render3(simplify(self, config), config));
var simplify = (self, config) => {
  switch (self._tag) {
    case "Empty": {
      return empty8;
    }
    case "Mixed": {
      return mixed;
    }
    case "Named": {
      if (isNone(head(render3(self, config)))) {
        return empty8;
      }
      return self;
    }
    case "Optional": {
      if (self.usage._tag === "Empty") {
        return empty8;
      }
      const usage = simplify(self.usage, config);
      return usage._tag === "Empty" ? empty8 : usage._tag === "Optional" ? usage : optional(usage);
    }
    case "Repeated": {
      const usage = simplify(self.usage, config);
      return usage._tag === "Empty" ? empty8 : repeated(usage);
    }
    case "Alternation": {
      const leftUsage = simplify(self.left, config);
      const rightUsage = simplify(self.right, config);
      return leftUsage._tag === "Empty" ? rightUsage : rightUsage._tag === "Empty" ? leftUsage : alternation(leftUsage, rightUsage);
    }
    case "Concat": {
      const leftUsage = simplify(self.left, config);
      const rightUsage = simplify(self.right, config);
      return leftUsage._tag === "Empty" ? rightUsage : rightUsage._tag === "Empty" ? leftUsage : concat2(leftUsage, rightUsage);
    }
  }
};
var render3 = (self, config) => {
  switch (self._tag) {
    case "Empty": {
      return of(text4(""));
    }
    case "Mixed": {
      return of(text4("<command>"));
    }
    case "Named": {
      const typeInfo = config.showTypes ? match(self.acceptedValues, {
        onNone: () => empty6,
        onSome: (s) => concat(space3, text4(s))
      }) : empty6;
      const namesToShow = config.showAllNames ? self.names : self.names.length > 1 ? pipe(filter(self.names, (name) => name.startsWith("--")), head, map(of), getOrElse(() => self.names)) : self.names;
      const nameInfo = text4(join$1(namesToShow, ", "));
      return config.showAllNames && self.names.length > 1 ? of(spans([text4("("), nameInfo, typeInfo, text4(")")])) : of(concat(nameInfo, typeInfo));
    }
    case "Optional": {
      return map2(render3(self.usage, config), (span2) => spans([text4("["), span2, text4("]")]));
    }
    case "Repeated": {
      return map2(render3(self.usage, config), (span2) => concat(span2, text4("...")));
    }
    case "Alternation": {
      if (self.left._tag === "Repeated" || self.right._tag === "Repeated" || self.left._tag === "Concat" || self.right._tag === "Concat") {
        return appendAll(render3(self.left, config), render3(self.right, config));
      }
      return flatMap2(render3(self.left, config), (left2) => map2(render3(self.right, config), (right2) => spans([left2, text4("|"), right2])));
    }
    case "Concat": {
      const leftSpan = render3(self.left, config);
      const rightSpan = render3(self.right, config);
      const separator = isNonEmptyReadonlyArray(leftSpan) && isNonEmptyReadonlyArray(rightSpan) ? space3 : empty6;
      return flatMap2(leftSpan, (left2) => map2(rightSpan, (right2) => spans([left2, separator, right2])));
    }
  }
};

// node_modules/@effect/cli/dist/esm/internal/validationError.js
var ValidationErrorSymbolKey = "@effect/cli/ValidationError";
var ValidationErrorTypeId = /* @__PURE__ */ Symbol.for(ValidationErrorSymbolKey);
var proto7 = {
  [ValidationErrorTypeId]: ValidationErrorTypeId
};
var isValidationError = (u) => typeof u === "object" && u != null && ValidationErrorTypeId in u;
var isCommandMismatch = (self) => self._tag === "CommandMismatch";
var isHelpRequested = (self) => self._tag === "HelpRequested";
var isMultipleValuesDetected = (self) => self._tag === "MultipleValuesDetected";
var isMissingValue = (self) => self._tag === "MissingValue";
var commandMismatch = (error3) => {
  const op = Object.create(proto7);
  op._tag = "CommandMismatch";
  op.error = error3;
  return op;
};
var correctedFlag = (error3) => {
  const op = Object.create(proto7);
  op._tag = "CorrectedFlag";
  op.error = error3;
  return op;
};
var invalidArgument = (error3) => {
  const op = Object.create(proto7);
  op._tag = "InvalidArgument";
  op.error = error3;
  return op;
};
var invalidValue = (error3) => {
  const op = Object.create(proto7);
  op._tag = "InvalidValue";
  op.error = error3;
  return op;
};
var missingFlag = (error3) => {
  const op = Object.create(proto7);
  op._tag = "MissingFlag";
  op.error = error3;
  return op;
};
var missingValue = (error3) => {
  const op = Object.create(proto7);
  op._tag = "MissingValue";
  op.error = error3;
  return op;
};
var multipleValuesDetected = (error3, values) => {
  const op = Object.create(proto7);
  op._tag = "MultipleValuesDetected";
  op.error = error3;
  op.values = values;
  return op;
};
var noBuiltInMatch = (error3) => {
  const op = Object.create(proto7);
  op._tag = "NoBuiltInMatch";
  op.error = error3;
  return op;
};
var unclusteredFlag = (error3, unclustered, rest) => {
  const op = Object.create(proto7);
  op._tag = "UnclusteredFlag";
  op.error = error3;
  op.unclustered = unclustered;
  op.rest = rest;
  return op;
};

// node_modules/@effect/cli/dist/esm/internal/args.js
var ArgsSymbolKey = "@effect/cli/Args";
var ArgsTypeId = /* @__PURE__ */ Symbol.for(ArgsSymbolKey);
var proto8 = {
  [ArgsTypeId]: {
    _A: (_) => _
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isArgs = (u) => typeof u === "object" && u != null && ArgsTypeId in u;
var isEmpty6 = (self) => self._tag === "Empty";
var all = function() {
  if (arguments.length === 1) {
    if (isArgs(arguments[0])) {
      return map9(arguments[0], (x) => [x]);
    } else if (isArray(arguments[0])) {
      return allTupled(arguments[0]);
    } else {
      const entries = Object.entries(arguments[0]);
      let result = map9(entries[0][1], (value2) => ({
        [entries[0][0]]: value2
      }));
      if (entries.length === 1) {
        return result;
      }
      const rest = entries.slice(1);
      for (const [key, options3] of rest) {
        result = map9(makeBoth(result, options3), ([record, value2]) => ({
          ...record,
          [key]: value2
        }));
      }
      return result;
    }
  }
  return allTupled(arguments[0]);
};
var none3 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto8);
  op._tag = "Empty";
  return op;
})();
var getHelp3 = (self) => getHelpInternal2(self);
var getUsage = (self) => getUsageInternal(self);
var map9 = /* @__PURE__ */ dual(2, (self, f) => mapEffect(self, (a) => succeed(f(a))));
var mapEffect = /* @__PURE__ */ dual(2, (self, f) => makeMap(self, f));
var validate2 = /* @__PURE__ */ dual(3, (self, args, config) => validateInternal2(self, args, config));
var wizard2 = /* @__PURE__ */ dual(2, (self, config) => wizardInternal2(self, config));
var allTupled = (arg) => {
  if (arg.length === 0) {
    return none3;
  }
  if (arg.length === 1) {
    return map9(arg[0], (x) => [x]);
  }
  let result = map9(arg[0], (x) => [x]);
  for (let i = 1; i < arg.length; i++) {
    const curr = arg[i];
    result = map9(makeBoth(result, curr), ([a, b]) => [...a, b]);
  }
  return result;
};
var getHelpInternal2 = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty7;
    }
    case "Single": {
      return descriptionList([[weak(self.name), sequence(p(getHelp(self.primitiveType)), self.description)]]);
    }
    case "Map": {
      return getHelpInternal2(self.args);
    }
    case "Both": {
      return sequence(getHelpInternal2(self.left), getHelpInternal2(self.right));
    }
    case "Variadic": {
      const help = getHelpInternal2(self.args);
      return mapDescriptionList(help, (oldSpan, oldBlock) => {
        const min2 = getMinSizeInternal(self);
        const max2 = getMaxSizeInternal(self);
        const newSpan = text4(isSome(self.max) ? ` ${min2} - ${max2}` : min2 === 0 ? "..." : ` ${min2}+`);
        const newBlock = p(isSome(self.max) ? `This argument must be repeated at least ${min2} times and may be repeated up to ${max2} times.` : min2 === 0 ? "This argument may be repeated zero or more times." : `This argument must be repeated at least ${min2} times.`);
        return [concat(oldSpan, newSpan), sequence(oldBlock, newBlock)];
      });
    }
    case "WithDefault": {
      return mapDescriptionList(getHelpInternal2(self.args), (span2, block) => {
        const optionalDescription = isOption(self.fallback) ? match(self.fallback, {
          onNone: () => p("This setting is optional."),
          onSome: (fallbackValue) => {
            const inspectableValue = isObject(fallbackValue) ? fallbackValue : String(fallbackValue);
            const displayValue = toStringUnknown(inspectableValue, 0);
            return p(`This setting is optional. Defaults to: ${displayValue}`);
          }
        }) : p("This setting is optional.");
        return [span2, sequence(block, optionalDescription)];
      });
    }
    case "WithFallbackConfig": {
      return mapDescriptionList(getHelpInternal2(self.args), (span2, block) => [span2, sequence(block, p("This argument can be set from environment variables."))]);
    }
  }
};
var getMinSizeInternal = (self) => {
  switch (self._tag) {
    case "Empty":
    case "WithDefault":
    case "WithFallbackConfig": {
      return 0;
    }
    case "Single": {
      return 1;
    }
    case "Map": {
      return getMinSizeInternal(self.args);
    }
    case "Both": {
      const leftMinSize = getMinSizeInternal(self.left);
      const rightMinSize = getMinSizeInternal(self.right);
      return leftMinSize + rightMinSize;
    }
    case "Variadic": {
      const argsMinSize = getMinSizeInternal(self.args);
      return Math.floor(getOrElse(self.min, () => 0) * argsMinSize);
    }
  }
};
var getMaxSizeInternal = (self) => {
  switch (self._tag) {
    case "Empty": {
      return 0;
    }
    case "Single": {
      return 1;
    }
    case "Map":
    case "WithDefault":
    case "WithFallbackConfig": {
      return getMaxSizeInternal(self.args);
    }
    case "Both": {
      const leftMaxSize = getMaxSizeInternal(self.left);
      const rightMaxSize = getMaxSizeInternal(self.right);
      return leftMaxSize + rightMaxSize;
    }
    case "Variadic": {
      const argsMaxSize = getMaxSizeInternal(self.args);
      return Math.floor(getOrElse(self.max, () => Number.MAX_SAFE_INTEGER / 2) * argsMaxSize);
    }
  }
};
var getUsageInternal = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty8;
    }
    case "Single": {
      return named(of(self.name), getChoices(self.primitiveType));
    }
    case "Map": {
      return getUsageInternal(self.args);
    }
    case "Both": {
      return concat2(getUsageInternal(self.left), getUsageInternal(self.right));
    }
    case "Variadic": {
      return repeated(getUsageInternal(self.args));
    }
    case "WithDefault":
    case "WithFallbackConfig": {
      return optional(getUsageInternal(self.args));
    }
  }
};
var makeMap = (self, f) => {
  const op = Object.create(proto8);
  op._tag = "Map";
  op.args = self;
  op.f = f;
  return op;
};
var makeBoth = (left2, right2) => {
  const op = Object.create(proto8);
  op._tag = "Both";
  op.left = left2;
  op.right = right2;
  return op;
};
var validateInternal2 = (self, args, config) => {
  switch (self._tag) {
    case "Empty": {
      return succeed([args, void 0]);
    }
    case "Single": {
      return suspend(() => {
        return matchLeft(args, {
          onEmpty: () => {
            const choices = getChoices(self.primitiveType);
            if (isSome(self.pseudoName) && isSome(choices)) {
              return fail2$1(missingValue(p(`Missing argument <${self.pseudoName.value}> with choices ${choices.value}`)));
            }
            if (isSome(self.pseudoName)) {
              return fail2$1(missingValue(p(`Missing argument <${self.pseudoName.value}>`)));
            }
            if (isSome(choices)) {
              return fail2$1(missingValue(p(`Missing argument ${getTypeName(self.primitiveType)} with choices ${choices.value}`)));
            }
            return fail2$1(missingValue(p(`Missing argument ${getTypeName(self.primitiveType)}`)));
          },
          onNonEmpty: (head2, tail) => validate(self.primitiveType, some(head2), config).pipe(mapBoth({
            onFailure: (text9) => invalidArgument(p(text9)),
            onSuccess: (a) => [tail, a]
          }))
        });
      });
    }
    case "Map": {
      return validateInternal2(self.args, args, config).pipe(flatMap3(([leftover, a]) => matchEffect(self.f(a), {
        onFailure: (doc) => fail2$1(invalidArgument(doc)),
        onSuccess: (b) => succeed([leftover, b])
      })));
    }
    case "Both": {
      return validateInternal2(self.left, args, config).pipe(flatMap3(([args2, a]) => validateInternal2(self.right, args2, config).pipe(map3(([args3, b]) => [args3, [a, b]]))));
    }
    case "Variadic": {
      const min1 = getOrElse(self.min, () => 0);
      const max1 = getOrElse(self.max, () => Number.MAX_SAFE_INTEGER);
      const loop = (args2, acc) => {
        if (acc.length >= max1) {
          return succeed([args2, acc]);
        }
        return validateInternal2(self.args, args2, config).pipe(matchEffect({
          onFailure: (failure) => acc.length >= min1 && isEmptyReadonlyArray(args2) ? succeed([args2, acc]) : fail2$1(failure),
          onSuccess: ([args3, a]) => loop(args3, append(acc, a))
        }));
      };
      return loop(args, empty()).pipe(map3(([args2, acc]) => [args2, acc]));
    }
    case "WithDefault": {
      return validateInternal2(self.args, args, config).pipe(catchTag("MissingValue", () => succeed([args, self.fallback])));
    }
    case "WithFallbackConfig": {
      return validateInternal2(self.args, args, config).pipe(catchTag("MissingValue", (e) => map3(catchAll(self.config, (e2) => {
        if (isMissingDataOnly(e2)) {
          const help = p(String(e2));
          const error3 = invalidValue(help);
          return fail2$1(error3);
        }
        return fail2$1(e);
      }), (value2) => [args, value2])));
    }
  }
};
var wizardInternal2 = (self, config) => {
  switch (self._tag) {
    case "Empty": {
      return succeed(empty());
    }
    case "Single": {
      const help = getHelpInternal2(self);
      return wizard(self.primitiveType, help).pipe(zipLeft(log()), flatMap3((input) => {
        const args = of(input);
        return validateInternal2(self, args, config).pipe(as(args));
      }));
    }
    case "Map": {
      return wizardInternal2(self.args, config).pipe(tap((args) => validateInternal2(self.args, args, config)));
    }
    case "Both": {
      return zipWith(wizardInternal2(self.left, config), wizardInternal2(self.right, config), (left2, right2) => appendAll(left2, right2)).pipe(tap((args) => validateInternal2(self, args, config)));
    }
    case "Variadic": {
      const repeatHelp = p("How many times should this argument should be repeated?");
      const message = pipe(getHelpInternal2(self), sequence(repeatHelp));
      return integer({
        message: toAnsiText(message).trimEnd(),
        min: getMinSizeInternal(self),
        max: getMaxSizeInternal(self)
      }).pipe(zipLeft(log()), flatMap3((n) => n <= 0 ? succeed(empty()) : make4(empty()).pipe(flatMap3((ref) => wizardInternal2(self.args, config).pipe(flatMap3((args) => update(ref, appendAll(args))), repeatN(n - 1), zipRight(get2(ref)), tap((args) => validateInternal2(self, args, config)))))));
    }
    case "WithDefault": {
      const defaultHelp = p(`This argument is optional - use the default?`);
      const message = pipe(getHelpInternal2(self.args), sequence(defaultHelp));
      return select({
        message: toAnsiText(message).trimEnd(),
        choices: [{
          title: `Default ['${JSON.stringify(self.fallback)}']`,
          value: true
        }, {
          title: "Custom",
          value: false
        }]
      }).pipe(zipLeft(log()), flatMap3((useFallback) => useFallback ? succeed(empty()) : wizardInternal2(self.args, config)));
    }
    case "WithFallbackConfig": {
      const defaultHelp = p(`Try load this option from the environment?`);
      const message = pipe(getHelpInternal2(self.args), sequence(defaultHelp));
      return select({
        message: toAnsiText(message).trimEnd(),
        choices: [{
          title: `Use environment variables`,
          value: true
        }, {
          title: "Custom",
          value: false
        }]
      }).pipe(zipLeft(log()), flatMap3((useFallback) => useFallback ? succeed(empty()) : wizardInternal2(self.args, config)));
    }
  }
};
var getShortDescription = (self) => {
  switch (self._tag) {
    case "Empty":
    case "Both": {
      return "";
    }
    case "Single": {
      return getText(getSpan(self.description));
    }
    case "Map":
    case "Variadic":
    case "WithDefault":
    case "WithFallbackConfig": {
      return getShortDescription(self.args);
    }
  }
};
var getFishCompletions2 = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty();
    }
    case "Single": {
      const description = getShortDescription(self);
      return pipe(getFishCompletions(self.primitiveType), appendAll(description.length === 0 ? empty() : of(`-d '${description}'`)), join$1(" "), of);
    }
    case "Both": {
      return pipe(getFishCompletions2(self.left), appendAll(getFishCompletions2(self.right)));
    }
    case "Map":
    case "Variadic":
    case "WithDefault":
    case "WithFallbackConfig": {
      return getFishCompletions2(self.args);
    }
  }
};
var getZshCompletions2 = (self, state = {
  multiple: false,
  optional: false
}) => {
  switch (self._tag) {
    case "Empty": {
      return empty();
    }
    case "Single": {
      const multiple = state.multiple ? "*" : "";
      const optional4 = state.optional ? "::" : ":";
      const shortDescription = getShortDescription(self);
      const description = shortDescription.length > 0 ? ` -- ${shortDescription}` : "";
      const possibleValues = getZshCompletions(self.primitiveType);
      return possibleValues.length === 0 ? empty() : of(`${multiple}${optional4}${self.name}${description}${possibleValues}`);
    }
    case "Map": {
      return getZshCompletions2(self.args, state);
    }
    case "Both": {
      const left2 = getZshCompletions2(self.left, state);
      const right2 = getZshCompletions2(self.right, state);
      return appendAll(left2, right2);
    }
    case "Variadic": {
      return isSome(self.max) && self.max.value > 1 ? getZshCompletions2(self.args, {
        ...state,
        multiple: true
      }) : getZshCompletions2(self.args, state);
    }
    case "WithDefault":
    case "WithFallbackConfig": {
      return getZshCompletions2(self.args, {
        ...state,
        optional: true
      });
    }
  }
};

// node_modules/@effect/cli/dist/esm/internal/autoCorrect.js
var levensteinDistance = (first2, second, config) => {
  if (first2.length === 0 && second.length === 0) {
    return 0;
  }
  if (first2.length === 0) {
    return second.length;
  }
  if (second.length === 0) {
    return first2.length;
  }
  const rowCount = first2.length;
  const columnCount = second.length;
  const matrix = new Array(rowCount);
  const normalFirst = normalizeCase(config, first2);
  const normalSecond = normalizeCase(config, second);
  for (let x = 0; x <= rowCount; x++) {
    matrix[x] = new Array(columnCount);
    matrix[x][0] = x;
  }
  for (let y = 0; y <= columnCount; y++) {
    matrix[0][y] = y;
  }
  for (let row = 1; row <= rowCount; row++) {
    for (let col = 1; col <= columnCount; col++) {
      const cost = normalFirst.charAt(row - 1) === normalSecond.charAt(col - 1) ? 0 : 1;
      matrix[row][col] = Math.min(matrix[row][col - 1] + 1, Math.min(matrix[row - 1][col] + 1, matrix[row - 1][col - 1] + cost));
    }
  }
  return matrix[rowCount][columnCount];
};

// node_modules/@effect/cli/dist/esm/internal/prompt/list.js
var list3 = (options3) => text5(options3).pipe(map8((output) => output.split(options3.delimiter || ",")));

// node_modules/@effect/cli/dist/esm/internal/options.js
var OptionsSymbolKey = "@effect/cli/Options";
var OptionsTypeId = /* @__PURE__ */ Symbol.for(OptionsSymbolKey);
var proto9 = {
  [OptionsTypeId]: {
    _A: (_) => _
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isOptions = (u) => typeof u === "object" && u != null && OptionsTypeId in u;
var isInstruction = (self) => self;
var isEmpty7 = (self) => self._tag === "Empty";
var isSingle = (self) => self._tag === "Single";
var isWithDefault = (self) => self._tag === "WithDefault";
var all2 = function() {
  if (arguments.length === 1) {
    if (isOptions(arguments[0])) {
      return map10(arguments[0], (x) => [x]);
    } else if (isArray(arguments[0])) {
      return allTupled2(arguments[0]);
    } else {
      const entries = Object.entries(arguments[0]);
      let result = map10(entries[0][1], (value2) => ({
        [entries[0][0]]: value2
      }));
      if (entries.length === 1) {
        return result;
      }
      const rest = entries.slice(1);
      for (const [key, options3] of rest) {
        result = map10(makeBoth2(result, options3), ([record, value2]) => ({
          ...record,
          [key]: value2
        }));
      }
      return result;
    }
  }
  return allTupled2(arguments[0]);
};
var defaultBooleanOptions = {
  ifPresent: true,
  negationNames: [],
  aliases: []
};
var boolean3 = (name, options3) => {
  const {
    aliases,
    ifPresent,
    negationNames
  } = {
    ...defaultBooleanOptions,
    ...options3
  };
  const option = makeSingle(name, aliases, boolean2(some(ifPresent)));
  if (isNonEmptyReadonlyArray(negationNames)) {
    const head2 = headNonEmpty(negationNames);
    const tail = tailNonEmpty(negationNames);
    const negationOption = makeSingle(head2, tail, boolean2(some(!ifPresent)));
    return withDefault(orElse4(option, negationOption), !ifPresent);
  }
  return withDefault(option, !ifPresent);
};
var choice2 = (name, choices) => {
  const primitive = choice(map2(choices, (choice4) => [choice4, choice4]));
  return makeSingle(name, empty(), primitive);
};
var choiceWithValue = (name, choices) => makeSingle(name, empty(), choice(choices));
var date3 = (name) => makeSingle(name, empty(), date2);
var directory = (name, config) => makeSingle(name, empty(), path("directory", config?.exists ?? "either"));
var file2 = (name, config) => makeSingle(name, empty(), path("file", config?.exists ?? "either"));
var fileContent = (name) => mapEffect2(file2(name, {
  exists: "yes"
}), (path2) => mapError(read(path2), (msg) => invalidValue(p(msg))));
var fileParse = (name, format) => mapEffect2(fileText(name), ([path2, content]) => mapError(parse4(path2, content, format), (error3) => invalidValue(p(error3))));
var fileSchema = (name, schema, format) => withSchema(fileParse(name, format), schema);
var fileText = (name) => mapEffect2(file2(name, {
  exists: "yes"
}), (path2) => mapError(readString(path2), (error3) => invalidValue(p(error3))));
var filterMap2 = /* @__PURE__ */ dual(3, (self, f, message) => mapEffect2(self, (a) => match(f(a), {
  onNone: () => left(invalidValue(p(message))),
  onSome: right
})));
var float3 = (name) => makeSingle(name, empty(), float2);
var integer3 = (name) => makeSingle(name, empty(), integer2);
var keyValueMap = (option) => {
  if (typeof option === "string") {
    const single = makeSingle(option, empty(), text6);
    return makeKeyValueMap(single);
  }
  if (!isSingle(option)) {
    throw new Error("InvalidArgumentException: only single options can be key/value maps");
  } else {
    return makeKeyValueMap(option);
  }
};
var none4 = /* @__PURE__ */ (() => {
  const op = /* @__PURE__ */ Object.create(proto9);
  op._tag = "Empty";
  return op;
})();
var redacted2 = (name) => makeSingle(name, empty(), redacted);
var secret2 = (name) => makeSingle(name, empty(), secret);
var text7 = (name) => makeSingle(name, empty(), text6);
var atLeast = /* @__PURE__ */ dual(2, (self, times) => makeVariadic(self, some(times), none()));
var atMost = /* @__PURE__ */ dual(2, (self, times) => makeVariadic(self, none(), some(times)));
var between = /* @__PURE__ */ dual(3, (self, min2, max2) => makeVariadic(self, some(min2), some(max2)));
var isBool2 = (self) => isBoolInternal(self);
var getHelp4 = (self) => getHelpInternal3(self);
var getIdentifier = (self) => getIdentifierInternal(self);
var getUsage2 = (self) => getUsageInternal2(self);
var map10 = /* @__PURE__ */ dual(2, (self, f) => makeMap2(self, (a) => right(f(a))));
var mapEffect2 = /* @__PURE__ */ dual(2, (self, f) => makeMap2(self, f));
var mapTryCatch = /* @__PURE__ */ dual(3, (self, f, onError) => mapEffect2(self, (a) => {
  try {
    return right(f(a));
  } catch (e) {
    return left(invalidValue(onError(e)));
  }
}));
var optional2 = (self) => withDefault(map10(self, some), none());
var orElse4 = /* @__PURE__ */ dual(2, (self, that) => orElseEither(self, that).pipe(map10(merge)));
var orElseEither = /* @__PURE__ */ dual(2, (self, that) => makeOrElse(self, that));
var parse5 = /* @__PURE__ */ dual(3, (self, args, config) => parseInternal(self, args, config));
var processCommandLine = /* @__PURE__ */ dual(3, (self, args, config) => matchOptions(args, toParseableInstruction(self), config).pipe(flatMap3(([error3, commandArgs, matchedOptions]) => parseInternal(self, matchedOptions, config).pipe(catchAll((e) => match(error3, {
  onNone: () => fail2$1(e),
  onSome: (err) => fail2$1(err)
})), map3((a) => [error3, commandArgs, a])))));
var repeated2 = (self) => makeVariadic(self, none(), none());
var withAlias = /* @__PURE__ */ dual(2, (self, alias) => modifySingle(self, (single) => {
  const aliases = append(single.aliases, alias);
  return makeSingle(single.name, aliases, single.primitiveType, single.description, single.pseudoName);
}));
var withDefault = /* @__PURE__ */ dual(2, (self, fallback) => makeWithDefault(self, fallback));
var withFallbackConfig = /* @__PURE__ */ dual(2, (self, config) => {
  if (isInstruction(self) && isWithDefault(self)) {
    return makeWithDefault(withFallbackConfig(self.options, config), self.fallback);
  }
  return makeWithFallback(self, config);
});
var withFallbackPrompt = /* @__PURE__ */ dual(2, (self, prompt4) => {
  if (isInstruction(self) && isWithDefault(self)) {
    return makeWithDefault(withFallbackPrompt(self.options, prompt4), self.fallback);
  }
  return makeWithFallback(self, prompt4);
});
var withDescription = /* @__PURE__ */ dual(2, (self, desc) => modifySingle(self, (single) => {
  const description = sequence(single.description, p(desc));
  return makeSingle(single.name, single.aliases, single.primitiveType, description, single.pseudoName);
}));
var withPseudoName = /* @__PURE__ */ dual(2, (self, pseudoName) => modifySingle(self, (single) => makeSingle(single.name, single.aliases, single.primitiveType, single.description, some(pseudoName))));
var withSchema = /* @__PURE__ */ dual(2, (self, schema) => {
  const decode2 = decode(schema);
  return mapEffect2(self, (_) => mapError(decode2(_), (issue) => invalidValue(p(TreeFormatter.formatIssueSync(issue)))));
});
var wizard3 = /* @__PURE__ */ dual(2, (self, config) => wizardInternal3(self, config));
var allTupled2 = (arg) => {
  if (arg.length === 0) {
    return none4;
  }
  if (arg.length === 1) {
    return map10(arg[0], (x) => [x]);
  }
  let result = map10(arg[0], (x) => [x]);
  for (let i = 1; i < arg.length; i++) {
    const curr = arg[i];
    result = map10(makeBoth2(result, curr), ([a, b]) => [...a, b]);
  }
  return result;
};
var getHelpInternal3 = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty7;
    }
    case "Single": {
      return descriptionList(of([getSpan(getHelp2(getUsageInternal2(self))), sequence(p(getHelp(self.primitiveType)), self.description)]));
    }
    case "KeyValueMap": {
      const identifier = getOrThrow(getIdentifierInternal(self.argumentOption));
      return mapDescriptionList(getHelpInternal3(self.argumentOption), (span2, oldBlock) => {
        const header = p("This setting is a property argument which:");
        const single = `${identifier} key1=value key2=value2`;
        const multiple = `${identifier} key1=value ${identifier} key2=value2`;
        const description = enumeration([p(`May be specified a single time:  '${single}'`), p(`May be specified multiple times: '${multiple}'`)]);
        const newBlock = pipe(oldBlock, sequence(header), sequence(description));
        return [span2, newBlock];
      });
    }
    case "Map": {
      return getHelpInternal3(self.options);
    }
    case "Both":
    case "OrElse": {
      return sequence(getHelpInternal3(self.left), getHelpInternal3(self.right));
    }
    case "Variadic": {
      const help = getHelpInternal3(self.argumentOption);
      return mapDescriptionList(help, (oldSpan, oldBlock) => {
        const min2 = getMinSizeInternal2(self);
        const max2 = getMaxSizeInternal2(self);
        const newSpan = text4(isSome(self.max) ? ` ${min2} - ${max2}` : min2 === 0 ? "..." : ` ${min2}+`);
        const newBlock = p(isSome(self.max) ? `This option must be repeated at least ${min2} times and may be repeated up to ${max2} times.` : min2 === 0 ? "This option may be repeated zero or more times." : `This option must be repeated at least ${min2} times.`);
        return [concat(oldSpan, newSpan), sequence(oldBlock, newBlock)];
      });
    }
    case "WithDefault": {
      return mapDescriptionList(getHelpInternal3(self.options), (span2, block) => {
        const optionalDescription = isOption(self.fallback) ? match(self.fallback, {
          onNone: () => p("This setting is optional."),
          onSome: (fallbackValue) => {
            const inspectableValue = isObject(fallbackValue) ? fallbackValue : String(fallbackValue);
            const displayValue = toStringUnknown(inspectableValue, 0);
            return p(`This setting is optional. Defaults to: ${displayValue}`);
          }
        }) : p("This setting is optional.");
        return [span2, sequence(block, optionalDescription)];
      });
    }
    case "WithFallback": {
      const helpDoc = isConfig(self.effect) ? p("This option can be set from environment variables.") : isPrompt(self.effect) ? p("Will prompt the user for input if this option is not provided.") : empty7;
      return mapDescriptionList(getHelpInternal3(self.options), (span2, block) => [span2, sequence(block, helpDoc)]);
    }
  }
};
var getIdentifierInternal = (self) => {
  switch (self._tag) {
    case "Empty": {
      return none();
    }
    case "Single": {
      return some(self.fullName);
    }
    case "Both":
    case "OrElse": {
      const ids = getSomes([getIdentifierInternal(self.left), getIdentifierInternal(self.right)]);
      return match2(ids, {
        onEmpty: () => none(),
        onNonEmpty: (ids2) => some(join$1(ids2, ", "))
      });
    }
    case "KeyValueMap":
    case "Variadic": {
      return getIdentifierInternal(self.argumentOption);
    }
    case "Map":
    case "WithFallback":
    case "WithDefault": {
      return getIdentifierInternal(self.options);
    }
  }
};
var getMinSizeInternal2 = (self) => {
  switch (self._tag) {
    case "Empty":
    case "WithDefault":
    case "WithFallback": {
      return 0;
    }
    case "Single":
    case "KeyValueMap": {
      return 1;
    }
    case "Map": {
      return getMinSizeInternal2(self.options);
    }
    case "Both": {
      const leftMinSize = getMinSizeInternal2(self.left);
      const rightMinSize = getMinSizeInternal2(self.right);
      return leftMinSize + rightMinSize;
    }
    case "OrElse": {
      const leftMinSize = getMinSizeInternal2(self.left);
      const rightMinSize = getMinSizeInternal2(self.right);
      return Math.min(leftMinSize, rightMinSize);
    }
    case "Variadic": {
      const selfMinSize = getOrElse(self.min, () => 0);
      const argumentOptionMinSize = getMinSizeInternal2(self.argumentOption);
      return selfMinSize * argumentOptionMinSize;
    }
  }
};
var getMaxSizeInternal2 = (self) => {
  switch (self._tag) {
    case "Empty": {
      return 0;
    }
    case "Single": {
      return 1;
    }
    case "KeyValueMap": {
      return Number.MAX_SAFE_INTEGER;
    }
    case "Map":
    case "WithDefault":
    case "WithFallback": {
      return getMaxSizeInternal2(self.options);
    }
    case "Both": {
      const leftMaxSize = getMaxSizeInternal2(self.left);
      const rightMaxSize = getMaxSizeInternal2(self.right);
      return leftMaxSize + rightMaxSize;
    }
    case "OrElse": {
      const leftMin = getMaxSizeInternal2(self.left);
      const rightMin = getMaxSizeInternal2(self.right);
      return Math.min(leftMin, rightMin);
    }
    case "Variadic": {
      const selfMaxSize = getOrElse(self.max, () => Number.MAX_SAFE_INTEGER / 2);
      const optionsMaxSize = getMaxSizeInternal2(self.argumentOption);
      return Math.floor(selfMaxSize * optionsMaxSize);
    }
  }
};
var getUsageInternal2 = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty8;
    }
    case "Single": {
      const acceptedValues = isBool(self.primitiveType) ? none() : orElse(getChoices(self.primitiveType), () => some(self.placeholder));
      return named(getNames(self), acceptedValues);
    }
    case "KeyValueMap": {
      return getUsageInternal2(self.argumentOption);
    }
    case "Map": {
      return getUsageInternal2(self.options);
    }
    case "Both": {
      return concat2(getUsageInternal2(self.left), getUsageInternal2(self.right));
    }
    case "OrElse": {
      return alternation(getUsageInternal2(self.left), getUsageInternal2(self.right));
    }
    case "Variadic": {
      return repeated(getUsageInternal2(self.argumentOption));
    }
    case "WithDefault":
    case "WithFallback": {
      return optional(getUsageInternal2(self.options));
    }
  }
};
var isBoolInternal = (self) => {
  switch (self._tag) {
    case "Single": {
      return isBool(self.primitiveType);
    }
    case "Map": {
      return isBoolInternal(self.options);
    }
    case "WithDefault": {
      return isBoolInternal(self.options);
    }
    default: {
      return false;
    }
  }
};
var makeBoth2 = (left2, right2) => {
  const op = Object.create(proto9);
  op._tag = "Both";
  op.left = left2;
  op.right = right2;
  return op;
};
var makeFullName = (str) => str.length === 1 ? [true, `-${str}`] : [false, `--${str}`];
var makeKeyValueMap = (argumentOption) => {
  const op = Object.create(proto9);
  op._tag = "KeyValueMap";
  op.argumentOption = argumentOption;
  return op;
};
var makeMap2 = (options3, f) => {
  const op = Object.create(proto9);
  op._tag = "Map";
  op.options = options3;
  op.f = f;
  return op;
};
var makeOrElse = (left2, right2) => {
  const op = Object.create(proto9);
  op._tag = "OrElse";
  op.left = left2;
  op.right = right2;
  return op;
};
var makeSingle = (name, aliases, primitiveType, description = empty7, pseudoName = none()) => {
  const op = Object.create(proto9);
  op._tag = "Single";
  op.name = name;
  op.fullName = makeFullName(name)[1];
  op.placeholder = `${getOrElse(pseudoName, () => getTypeName(primitiveType))}`;
  op.aliases = aliases;
  op.primitiveType = primitiveType;
  op.description = description;
  op.pseudoName = pseudoName;
  return op;
};
var makeVariadic = (argumentOption, min2, max2) => {
  if (!isSingle(argumentOption)) {
    throw new Error("InvalidArgumentException: only single options can be variadic");
  }
  const op = Object.create(proto9);
  op._tag = "Variadic";
  op.argumentOption = argumentOption;
  op.min = min2;
  op.max = max2;
  return op;
};
var makeWithDefault = (options3, fallback) => {
  const op = Object.create(proto9);
  op._tag = "WithDefault";
  op.options = options3;
  op.fallback = fallback;
  return op;
};
var makeWithFallback = (options3, effect) => {
  const op = Object.create(proto9);
  op._tag = "WithFallback";
  op.options = options3;
  op.effect = effect;
  return op;
};
var modifySingle = (self, f) => {
  switch (self._tag) {
    case "Empty": {
      return none4;
    }
    case "Single": {
      return f(self);
    }
    case "KeyValueMap": {
      return makeKeyValueMap(f(self.argumentOption));
    }
    case "Map": {
      return makeMap2(modifySingle(self.options, f), self.f);
    }
    case "Both": {
      return makeBoth2(modifySingle(self.left, f), modifySingle(self.right, f));
    }
    case "OrElse": {
      return makeOrElse(modifySingle(self.left, f), modifySingle(self.right, f));
    }
    case "Variadic": {
      return makeVariadic(f(self.argumentOption), self.min, self.max);
    }
    case "WithDefault": {
      return makeWithDefault(modifySingle(self.options, f), self.fallback);
    }
    case "WithFallback": {
      return makeWithFallback(modifySingle(self.options, f), self.effect);
    }
  }
};
var getNames = (self) => {
  const loop = (self2) => {
    switch (self2._tag) {
      case "Empty": {
        return empty();
      }
      case "Single": {
        return prepend(self2.aliases, self2.name);
      }
      case "KeyValueMap":
      case "Variadic": {
        return loop(self2.argumentOption);
      }
      case "Map":
      case "WithDefault":
      case "WithFallback": {
        return loop(self2.options);
      }
      case "Both":
      case "OrElse": {
        const left2 = loop(self2.left);
        const right2 = loop(self2.right);
        return appendAll(left2, right2);
      }
    }
  };
  const order = mapInput(boolean, (tuple3) => !tuple3[0]);
  return pipe(loop(self), map2((str) => makeFullName(str)), sort(order), map2((tuple3) => tuple3[1]));
};
var toParseableInstruction = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty();
    }
    case "Single":
    case "KeyValueMap":
    case "Variadic": {
      return of(self);
    }
    case "Map":
    case "WithDefault":
    case "WithFallback": {
      return toParseableInstruction(self.options);
    }
    case "Both":
    case "OrElse": {
      return appendAll(toParseableInstruction(self.left), toParseableInstruction(self.right));
    }
  }
};
var keyValueSplitter = /=(.*)/;
var parseInternal = (self, args, config) => {
  switch (self._tag) {
    case "Empty": {
      return _void;
    }
    case "Single": {
      const singleNames = filterMap(getNames(self), (name) => get(args, name));
      if (isNonEmptyReadonlyArray(singleNames)) {
        const head2 = headNonEmpty(singleNames);
        const tail = tailNonEmpty(singleNames);
        if (isEmptyReadonlyArray(tail)) {
          if (isEmptyReadonlyArray(head2)) {
            return validate(self.primitiveType, none(), config).pipe(mapError((e) => invalidValue(p(e))));
          }
          if (isNonEmptyReadonlyArray(head2) && isEmptyReadonlyArray(tailNonEmpty(head2))) {
            const value2 = headNonEmpty(head2);
            return validate(self.primitiveType, some(value2), config).pipe(mapError((e) => invalidValue(p(e))));
          }
          return fail2$1(multipleValuesDetected(empty7, head2));
        }
        const error4 = p(`More than one reference to option '${self.fullName}' detected`);
        return fail2$1(invalidValue(error4));
      }
      const error3 = p(`Expected to find option: '${self.fullName}'`);
      return fail2$1(missingValue(error3));
    }
    case "KeyValueMap": {
      const extractKeyValue = (value2) => {
        const split = value2.trim().split(keyValueSplitter, 2);
        if (isNonEmptyReadonlyArray(split) && split.length === 2 && split[1] !== "") {
          return succeed(split);
        }
        const error3 = p(`Expected a key/value pair but received '${value2}'`);
        return fail2$1(invalidArgument(error3));
      };
      return parseInternal(self.argumentOption, args, config).pipe(matchEffect({
        onFailure: (e) => isMultipleValuesDetected(e) ? forEach(e.values, (kv) => extractKeyValue(kv)).pipe(map3(fromIterable3)) : fail2$1(e),
        onSuccess: (kv) => extractKeyValue(kv).pipe(map3(make3))
      }));
    }
    case "Map": {
      return parseInternal(self.options, args, config).pipe(flatMap3((a) => self.f(a)));
    }
    case "Both": {
      return parseInternal(self.left, args, config).pipe(catchAll((err1) => parseInternal(self.right, args, config).pipe(matchEffect({
        onFailure: (err2) => {
          const error3 = sequence(err1.error, err2.error);
          return fail2$1(missingValue(error3));
        },
        onSuccess: () => fail2$1(err1)
      }))), zip(parseInternal(self.right, args, config)));
    }
    case "OrElse": {
      return parseInternal(self.left, args, config).pipe(matchEffect({
        onFailure: (err1) => parseInternal(self.right, args, config).pipe(mapBoth({
          onFailure: (err2) => (
            // orElse option is only missing in case neither option was given
            isMissingValue(err1) && isMissingValue(err2) ? missingValue(sequence(err1.error, err2.error)) : invalidValue(sequence(err1.error, err2.error))
          ),
          onSuccess: (b) => right(b)
        })),
        onSuccess: (a) => parseInternal(self.right, args, config).pipe(matchEffect({
          onFailure: () => succeed(left(a)),
          onSuccess: () => {
            const leftUid = getOrElse(getIdentifierInternal(self.left), () => "???");
            const rightUid = getOrElse(getIdentifierInternal(self.right), () => "???");
            const error3 = p(`Collision between two options detected - you can only specify one of either: ['${leftUid}', '${rightUid}']`);
            return fail2$1(invalidValue(error3));
          }
        }))
      }));
    }
    case "Variadic": {
      const min2 = getOrElse(self.min, () => 0);
      const max2 = getOrElse(self.max, () => Number.MAX_SAFE_INTEGER);
      const matchedArgument = filterMap(getNames(self), (name) => get(args, name));
      const validateMinMax = (values) => {
        if (values.length < min2) {
          const name = self.argumentOption.fullName;
          const error3 = `Expected at least ${min2} value(s) for option: '${name}'`;
          return fail2$1(invalidValue(p(error3)));
        }
        if (values.length > max2) {
          const name = self.argumentOption.fullName;
          const error3 = `Expected at most ${max2} value(s) for option: '${name}'`;
          return fail2$1(invalidValue(p(error3)));
        }
        const primitive = self.argumentOption.primitiveType;
        const validatePrimitive = (value2) => validate(primitive, some(value2), config).pipe(mapError((e) => invalidValue(p(e))));
        return forEach(values, (value2) => validatePrimitive(value2));
      };
      if (every(matchedArgument, isEmptyReadonlyArray)) {
        return validateMinMax(empty());
      }
      return parseInternal(self.argumentOption, args, config).pipe(matchEffect({
        onFailure: (error3) => isMultipleValuesDetected(error3) ? validateMinMax(error3.values) : fail2$1(error3),
        onSuccess: (value2) => validateMinMax(of(value2))
      }));
    }
    case "WithDefault": {
      return parseInternal(self.options, args, config).pipe(catchTag("MissingValue", () => succeed(self.fallback)));
    }
    case "WithFallback": {
      return parseInternal(self.options, args, config).pipe(catchTag("MissingValue", (e) => self.effect.pipe(catchAll((e2) => {
        if (isTagged(e2, "QuitException")) {
          return die(e2);
        }
        if (isConfigError(e2) && !isMissingDataOnly(e2)) {
          const help = p(String(e2));
          const error3 = invalidValue(help);
          return fail2$1(error3);
        }
        return fail2$1(e);
      }))));
    }
  }
};
var wizardInternal3 = (self, config) => {
  switch (self._tag) {
    case "Empty": {
      return succeed(empty());
    }
    case "Single": {
      const help = getHelpInternal3(self);
      return wizard(self.primitiveType, help).pipe(flatMap3((input) => {
        const args = make(getNames(self)[0], input);
        return parseCommandLine(self, args, config).pipe(as(args));
      }), zipLeft(log()));
    }
    case "KeyValueMap": {
      const message = p("Enter `key=value` pairs separated by spaces");
      return list3({
        message: toAnsiText(message).trim(),
        delimiter: " "
      }).pipe(flatMap3((args) => {
        const identifier = getOrElse(getIdentifierInternal(self), () => "");
        return parseInternal(self, make3([identifier, args]), config).pipe(as(prepend(args, identifier)));
      }), zipLeft(log()));
    }
    case "Map": {
      return wizardInternal3(self.options, config);
    }
    case "Both": {
      return zipWith(wizardInternal3(self.left, config), wizardInternal3(self.right, config), (left2, right2) => appendAll(left2, right2));
    }
    case "OrElse": {
      const alternativeHelp = p("Select which option you would like to use");
      const message = pipe(getHelpInternal3(self), sequence(alternativeHelp));
      const makeChoice = (title, value2) => ({
        title,
        value: value2
      });
      const choices = getSomes([map(getIdentifierInternal(self.left), (title) => makeChoice(title, self.left)), map(getIdentifierInternal(self.right), (title) => makeChoice(title, self.right))]);
      return select({
        message: toAnsiText(message).trimEnd(),
        choices
      }).pipe(flatMap3((option) => wizardInternal3(option, config)));
    }
    case "Variadic": {
      const repeatHelp = p("How many times should this argument be repeated?");
      const message = pipe(getHelpInternal3(self), sequence(repeatHelp));
      return integer({
        message: toAnsiText(message).trimEnd(),
        min: getMinSizeInternal2(self),
        max: getMaxSizeInternal2(self)
      }).pipe(flatMap3((n) => n <= 0 ? succeed(empty()) : make4(empty()).pipe(flatMap3((ref) => wizardInternal3(self.argumentOption, config).pipe(flatMap3((args) => update(ref, appendAll(args))), repeatN(n - 1), zipRight(get2(ref)))))));
    }
    case "WithDefault": {
      if (isBoolInternal(self.options)) {
        return wizardInternal3(self.options, config);
      }
      const defaultHelp = p(`This option is optional - use the default?`);
      const message = pipe(getHelpInternal3(self.options), sequence(defaultHelp));
      return select({
        message: toAnsiText(message).trimEnd(),
        choices: [{
          title: "Yes",
          value: true,
          description: `use the default ${isOption(self.fallback) ? match(self.fallback, {
            onNone: () => "",
            onSome: (a) => `(${JSON.stringify(a)})`
          }) : `(${JSON.stringify(self.fallback)})`}`
        }, {
          title: "No",
          value: false,
          description: "use a custom value"
        }]
      }).pipe(zipLeft(log()), flatMap3((useFallback) => useFallback ? succeed(empty()) : wizardInternal3(self.options, config)));
    }
    case "WithFallback": {
      if (isBoolInternal(self.options)) {
        return wizardInternal3(self.options, config);
      }
      if (isPrompt(self.effect)) {
        return wizardInternal3(self.options, config);
      }
      const defaultHelp = p(`Try load this option from the environment?`);
      const message = pipe(getHelpInternal3(self.options), sequence(defaultHelp));
      return select({
        message: toAnsiText(message).trimEnd(),
        choices: [{
          title: `Use environment variables`,
          value: true
        }, {
          title: "Custom",
          value: false
        }]
      }).pipe(zipLeft(log()), flatMap3((useFallback) => useFallback ? succeed(empty()) : wizardInternal3(self.options, config)));
    }
  }
};
var matchOptions = (input, options3, config) => {
  if (isNonEmptyReadonlyArray(options3)) {
    return findOptions(input, options3, config).pipe(flatMap3(([otherArgs, otherOptions, map1]) => {
      if (isEmpty(map1)) {
        return succeed([none(), input, map1]);
      }
      return matchOptions(otherArgs, otherOptions, config).pipe(map3(([error3, otherArgs2, map22]) => [error3, otherArgs2, merge2(map1, fromIterable(map22))]));
    }), catchAll((e) => succeed([some(e), input, empty2()])));
  }
  return isEmptyReadonlyArray(input) ? succeed([none(), empty(), empty2()]) : succeed([none(), input, empty2()]);
};
var findOptions = (input, options3, config) => matchLeft(options3, {
  onEmpty: () => succeed([input, empty(), empty2()]),
  onNonEmpty: (head2, tail) => parseCommandLine(head2, input, config).pipe(flatMap3(({
    leftover,
    parsed
  }) => match(parsed, {
    onNone: () => findOptions(leftover, tail, config).pipe(map3(([nextArgs, nextOptions, map13]) => [nextArgs, prepend(nextOptions, head2), map13])),
    onSome: ({
      name,
      values
    }) => succeed([leftover, tail, make3([name, values])])
  })), catchTags({
    CorrectedFlag: (e) => findOptions(input, tail, config).pipe(catchSome(() => some(fail2$1(e))), flatMap3(([otherArgs, otherOptions, map13]) => fail2$1(e).pipe(when(() => isEmpty(map13)), as([otherArgs, prepend(otherOptions, head2), map13])))),
    MissingFlag: () => findOptions(input, tail, config).pipe(map3(([otherArgs, otherOptions, map13]) => [otherArgs, prepend(otherOptions, head2), map13])),
    UnclusteredFlag: (e) => matchUnclustered(e.unclustered, e.rest, options3, config).pipe(catchAll(() => fail2$1(e)))
  }))
});
var CLUSTERED_REGEX = /^-{1}([^-]{2,}$)/;
var FLAG_REGEX = /^(--[^=]+)(?:=(.+))?$/;
var processArgs = (args) => matchLeft(args, {
  onEmpty: () => succeed(empty()),
  onNonEmpty: (head2, tail) => {
    const value2 = head2.trim();
    if (CLUSTERED_REGEX.test(value2)) {
      const unclustered = value2.substring(1).split("").map((c) => `-${c}`);
      return fail2$1(unclusteredFlag(empty7, unclustered, tail));
    }
    if (FLAG_REGEX.test(value2)) {
      const result = FLAG_REGEX.exec(value2);
      if (result !== null && result[2] !== void 0) {
        return succeed(appendAll([result[1], result[2]], tail));
      }
    }
    return succeed(args);
  }
});
var parseCommandLine = (self, args, config) => {
  switch (self._tag) {
    case "Single": {
      return processArgs(args).pipe(flatMap3((args2) => matchLeft(args2, {
        onEmpty: () => {
          const error3 = p(`Expected to find option: '${self.fullName}'`);
          return fail2$1(missingFlag(error3));
        },
        onNonEmpty: (head2, tail) => {
          const normalize = (value2) => normalizeCase(config, value2);
          const normalizedHead = normalize(head2);
          const normalizedNames = map2(getNames(self), (name) => normalize(name));
          if (contains(normalizedNames, normalizedHead)) {
            if (isBool(self.primitiveType)) {
              return matchLeft(tail, {
                onEmpty: () => {
                  const parsed2 = some({
                    name: head2,
                    values: empty()
                  });
                  return succeed({
                    parsed: parsed2,
                    leftover: tail
                  });
                },
                onNonEmpty: (value2, leftover2) => {
                  if (isTrueValue(value2)) {
                    const parsed3 = some({
                      name: head2,
                      values: of("true")
                    });
                    return succeed({
                      parsed: parsed3,
                      leftover: leftover2
                    });
                  }
                  if (isFalseValue(value2)) {
                    const parsed3 = some({
                      name: head2,
                      values: of("false")
                    });
                    return succeed({
                      parsed: parsed3,
                      leftover: leftover2
                    });
                  }
                  const parsed2 = some({
                    name: head2,
                    values: empty()
                  });
                  return succeed({
                    parsed: parsed2,
                    leftover: tail
                  });
                }
              });
            }
            return matchLeft(tail, {
              onEmpty: () => {
                const error3 = p(`Expected a value following option: '${self.fullName}'`);
                return fail2$1(missingValue(error3));
              },
              onNonEmpty: (value2, leftover2) => {
                const parsed2 = some({
                  name: head2,
                  values: of(value2)
                });
                return succeed({
                  parsed: parsed2,
                  leftover: leftover2
                });
              }
            });
          }
          if (head2.startsWith("-")) {
            if (self.name.length > config.autoCorrectLimit + 1 && levensteinDistance(head2, self.fullName, config) <= config.autoCorrectLimit) {
              const error4 = p(`The flag '${head2}' is not recognized. Did you mean '${self.fullName}'?`);
              return fail2$1(correctedFlag(error4));
            }
            const error3 = p(`Expected to find option: '${self.fullName}'`);
            return fail2$1(missingFlag(error3));
          }
          let optionIndex = -1;
          let equalsValue = void 0;
          for (let i = 0; i < tail.length; i++) {
            const arg = tail[i];
            const normalizedArg = normalize(arg);
            if (contains(normalizedNames, normalizedArg)) {
              optionIndex = i;
              break;
            }
            const flagMatch = FLAG_REGEX.exec(arg);
            if (flagMatch !== null) {
              const normalizedFlag = normalize(flagMatch[1]);
              if (contains(normalizedNames, normalizedFlag)) {
                optionIndex = i;
                equalsValue = flagMatch[2];
                break;
              }
            }
          }
          if (optionIndex === -1) {
            const error3 = p(`Expected to find option: '${self.fullName}'`);
            return fail2$1(missingFlag(error3));
          }
          const rawArg = tail[optionIndex];
          const optionName = equalsValue !== void 0 ? FLAG_REGEX.exec(rawArg)[1] : rawArg;
          const beforeOption = prepend(tail.slice(0, optionIndex), head2);
          const afterOption = tail.slice(optionIndex + 1);
          if (isBool(self.primitiveType)) {
            if (equalsValue !== void 0) {
              if (isTrueValue(equalsValue)) {
                const parsed3 = some({
                  name: optionName,
                  values: of("true")
                });
                const leftover3 = appendAll(beforeOption, afterOption);
                return succeed({
                  parsed: parsed3,
                  leftover: leftover3
                });
              }
              if (isFalseValue(equalsValue)) {
                const parsed3 = some({
                  name: optionName,
                  values: of("false")
                });
                const leftover3 = appendAll(beforeOption, afterOption);
                return succeed({
                  parsed: parsed3,
                  leftover: leftover3
                });
              }
            }
            if (afterOption.length > 0) {
              const nextValue = afterOption[0];
              if (isTrueValue(nextValue)) {
                const parsed3 = some({
                  name: optionName,
                  values: of("true")
                });
                const leftover3 = appendAll(beforeOption, afterOption.slice(1));
                return succeed({
                  parsed: parsed3,
                  leftover: leftover3
                });
              }
              if (isFalseValue(nextValue)) {
                const parsed3 = some({
                  name: optionName,
                  values: of("false")
                });
                const leftover3 = appendAll(beforeOption, afterOption.slice(1));
                return succeed({
                  parsed: parsed3,
                  leftover: leftover3
                });
              }
            }
            const parsed2 = some({
              name: optionName,
              values: empty()
            });
            const leftover2 = appendAll(beforeOption, afterOption);
            return succeed({
              parsed: parsed2,
              leftover: leftover2
            });
          }
          if (equalsValue !== void 0) {
            const parsed2 = some({
              name: optionName,
              values: of(equalsValue)
            });
            const leftover2 = appendAll(beforeOption, afterOption);
            return succeed({
              parsed: parsed2,
              leftover: leftover2
            });
          }
          if (afterOption.length === 0) {
            const error3 = p(`Expected a value following option: '${self.fullName}'`);
            return fail2$1(missingValue(error3));
          }
          const optionValue = afterOption[0];
          const parsed = some({
            name: optionName,
            values: of(optionValue)
          });
          const leftover = appendAll(beforeOption, afterOption.slice(1));
          return succeed({
            parsed,
            leftover
          });
        }
      })));
    }
    case "KeyValueMap": {
      const normalizedNames = map2(getNames(self.argumentOption), (name) => normalizeCase(config, name));
      return matchLeft(args, {
        onEmpty: () => succeed({
          parsed: none(),
          leftover: args
        }),
        onNonEmpty: (head2, tail) => {
          const loop = (args2) => {
            let keyValues = empty();
            let leftover2 = args2;
            while (isNonEmptyReadonlyArray(leftover2)) {
              const name = headNonEmpty(leftover2).trim();
              const normalizedName2 = normalizeCase(config, name);
              if (leftover2.length >= 2 && contains(normalizedNames, normalizedName2)) {
                const keyValue = leftover2[1].trim();
                const [key, value2] = keyValue.split("=");
                if (key !== void 0 && value2 !== void 0 && value2.length > 0) {
                  keyValues = append(keyValues, keyValue);
                  leftover2 = leftover2.slice(2);
                  continue;
                }
              }
              if (name.includes("=")) {
                const [key, value2] = name.split("=");
                if (key !== void 0 && value2 !== void 0 && value2.length > 0) {
                  keyValues = append(keyValues, name);
                  leftover2 = leftover2.slice(1);
                  continue;
                }
              }
              break;
            }
            return [keyValues, leftover2];
          };
          const normalizedName = normalizeCase(config, head2);
          if (contains(normalizedNames, normalizedName)) {
            const [values2, leftover2] = loop(tail);
            return succeed({
              parsed: some({
                name: head2,
                values: values2
              }),
              leftover: leftover2
            });
          }
          if (head2.startsWith("-")) {
            return succeed({
              parsed: none(),
              leftover: args
            });
          }
          let optionIndex = -1;
          for (let i = 0; i < tail.length; i++) {
            const arg = tail[i];
            const normalizedArg = normalizeCase(config, arg);
            if (contains(normalizedNames, normalizedArg)) {
              optionIndex = i;
              break;
            }
          }
          if (optionIndex === -1) {
            return succeed({
              parsed: none(),
              leftover: args
            });
          }
          const optionName = tail[optionIndex];
          const beforeOption = prepend(tail.slice(0, optionIndex), head2);
          const afterOption = tail.slice(optionIndex + 1);
          const [values, remaining] = loop(afterOption);
          const leftover = appendAll(beforeOption, remaining);
          return succeed({
            parsed: some({
              name: optionName,
              values
            }),
            leftover
          });
        }
      });
    }
    case "Variadic": {
      const normalizedNames = map2(getNames(self.argumentOption), (name) => normalizeCase(config, name));
      let optionName = void 0;
      let values = empty();
      let unparsed = args;
      let leftover = empty();
      while (isNonEmptyReadonlyArray(unparsed)) {
        const name = headNonEmpty(unparsed);
        const normalizedName = normalizeCase(config, name);
        if (contains(normalizedNames, normalizedName)) {
          if (optionName === void 0) {
            optionName = name;
          }
          const value2 = unparsed[1];
          if (value2 !== void 0 && value2.length > 0) {
            values = append(values, value2.trim());
          }
          unparsed = unparsed.slice(2);
        } else {
          leftover = append(leftover, headNonEmpty(unparsed));
          unparsed = unparsed.slice(1);
        }
      }
      const parsed = fromNullable(optionName).pipe(orElse(() => some(self.argumentOption.fullName)), map((name) => ({
        name,
        values
      })));
      return succeed({
        parsed,
        leftover
      });
    }
  }
};
var matchUnclustered = (input, tail, options3, config) => {
  if (isNonEmptyReadonlyArray(input)) {
    const flag = headNonEmpty(input);
    const otherFlags = tailNonEmpty(input);
    return findOptions(of(flag), options3, config).pipe(flatMap3(([_, opts1, map1]) => {
      if (isEmpty(map1)) {
        return fail2$1(unclusteredFlag(empty7, empty(), tail));
      }
      return matchUnclustered(otherFlags, tail, opts1, config).pipe(map3(([_2, opts2, map22]) => [tail, opts2, merge2(map1, fromIterable(map22))]));
    }));
  }
  return succeed([tail, options3, empty2()]);
};
var merge2 = (map1, map22) => {
  if (isNonEmptyReadonlyArray(map22)) {
    const head2 = headNonEmpty(map22);
    const tail = tailNonEmpty(map22);
    const newMap = match(get(map1, head2[0]), {
      onNone: () => set(map1, head2[0], head2[1]),
      onSome: (elems) => set(map1, head2[0], appendAll(elems, head2[1]))
    });
    return merge2(newMap, tail);
  }
  return map1;
};
var escape = (string5) => string5.replaceAll("\\", "\\\\").replaceAll("'", "'\\''").replaceAll("[", "\\[").replaceAll("]", "\\]").replaceAll(":", "\\:").replaceAll("$", "\\$").replaceAll("`", "\\`").replaceAll("(", "\\(").replaceAll(")", "\\)");
var getShortDescription2 = (self) => {
  switch (self._tag) {
    case "Empty":
    case "Both":
    case "OrElse": {
      return "";
    }
    case "Single": {
      return getText(getSpan(self.description));
    }
    case "KeyValueMap":
    case "Variadic": {
      return getShortDescription2(self.argumentOption);
    }
    case "Map":
    case "WithDefault":
    case "WithFallback": {
      return getShortDescription2(self.options);
    }
  }
};
var getBashCompletions2 = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty();
    }
    case "Single": {
      const names = getNames(self);
      const cases = join$1(names, "|");
      const compgen = getBashCompletions(self.primitiveType);
      return make(`${cases})`, `    COMPREPLY=( ${compgen} )`, `    return 0`, `    ;;`);
    }
    case "KeyValueMap":
    case "Variadic": {
      return getBashCompletions2(self.argumentOption);
    }
    case "Map":
    case "WithDefault":
    case "WithFallback": {
      return getBashCompletions2(self.options);
    }
    case "Both":
    case "OrElse": {
      const left2 = getBashCompletions2(self.left);
      const right2 = getBashCompletions2(self.right);
      return appendAll(left2, right2);
    }
  }
};
var getFishCompletions3 = (self) => {
  switch (self._tag) {
    case "Empty": {
      return empty();
    }
    case "Single": {
      const description = getShortDescription2(self);
      const order = mapInput(boolean, (tuple3) => !tuple3[0]);
      return pipe(prepend(self.aliases, self.name), map2((name) => [name.length === 1, name]), sort(order), flatMap2(([isShort, name]) => make(isShort ? "-s" : "-l", name)), appendAll(getFishCompletions(self.primitiveType)), appendAll(description.length === 0 ? empty() : of(`-d '${description}'`)), join$1(" "), of);
    }
    case "KeyValueMap":
    case "Variadic": {
      return getFishCompletions3(self.argumentOption);
    }
    case "Map":
    case "WithDefault":
    case "WithFallback": {
      return getFishCompletions3(self.options);
    }
    case "Both":
    case "OrElse": {
      return pipe(getFishCompletions3(self.left), appendAll(getFishCompletions3(self.right)));
    }
  }
};
var getZshCompletions3 = (self, state = {
  conflicts: empty(),
  multiple: false
}) => {
  switch (self._tag) {
    case "Empty": {
      return empty();
    }
    case "Single": {
      const names = getNames(self);
      const description = getShortDescription2(self);
      const possibleValues = getZshCompletions(self.primitiveType);
      const multiple = state.multiple ? "*" : "";
      const conflicts = isNonEmptyReadonlyArray(state.conflicts) ? `(${join$1(state.conflicts, " ")})` : "";
      return map2(names, (name) => `${conflicts}${multiple}${name}[${escape(description)}]${possibleValues}`);
    }
    case "KeyValueMap": {
      return getZshCompletions3(self.argumentOption, {
        ...state,
        multiple: true
      });
    }
    case "Map":
    case "WithDefault":
    case "WithFallback": {
      return getZshCompletions3(self.options, state);
    }
    case "Both": {
      const left2 = getZshCompletions3(self.left, state);
      const right2 = getZshCompletions3(self.right, state);
      return appendAll(left2, right2);
    }
    case "OrElse": {
      const leftNames = getNames(self.left);
      const rightNames = getNames(self.right);
      const left2 = getZshCompletions3(self.left, {
        ...state,
        conflicts: appendAll(state.conflicts, rightNames)
      });
      const right2 = getZshCompletions3(self.right, {
        ...state,
        conflicts: appendAll(state.conflicts, leftNames)
      });
      return appendAll(left2, right2);
    }
    case "Variadic": {
      return isSome(self.max) && self.max.value > 1 ? getZshCompletions3(self.argumentOption, {
        ...state,
        multiple: true
      }) : getZshCompletions3(self.argumentOption, state);
    }
  }
};

// node_modules/@effect/cli/dist/esm/internal/builtInOptions.js
var setLogLevel = (level) => ({
  _tag: "SetLogLevel",
  level
});
var showCompletions = (shellType) => ({
  _tag: "ShowCompletions",
  shellType
});
var showHelp = (usage, helpDoc) => ({
  _tag: "ShowHelp",
  usage,
  helpDoc
});
var showWizard = (command) => ({
  _tag: "ShowWizard",
  command
});
var showVersion = {
  _tag: "ShowVersion"
};
var isShowHelp = (self) => self._tag === "ShowHelp";
var isShowWizard = (self) => self._tag === "ShowWizard";
var completionsOptions = /* @__PURE__ */ choiceWithValue("completions", [["sh", "bash"], ["bash", "bash"], ["fish", "fish"], ["zsh", "zsh"]]).pipe(optional2, /* @__PURE__ */ withDescription("Generate a completion script for a specific shell."));
var logLevelOptions = /* @__PURE__ */ choiceWithValue("log-level", allLevels.map((level) => [level._tag.toLowerCase(), level])).pipe(optional2, /* @__PURE__ */ withDescription("Sets the minimum log level for a command."));
var helpOptions = /* @__PURE__ */ boolean3("help").pipe(/* @__PURE__ */ withAlias("h"), /* @__PURE__ */ withDescription("Show the help documentation for a command."));
var versionOptions = /* @__PURE__ */ boolean3("version").pipe(/* @__PURE__ */ withDescription("Show the version of the application."));
var wizardOptions = /* @__PURE__ */ boolean3("wizard").pipe(/* @__PURE__ */ withDescription("Start wizard mode for a command."));
var builtIns = /* @__PURE__ */ all2({
  completions: completionsOptions,
  logLevel: logLevelOptions,
  help: helpOptions,
  wizard: wizardOptions,
  version: versionOptions
});
var builtInOptions = (command, usage, helpDoc) => map10(builtIns, (builtIn2) => {
  if (isSome(builtIn2.completions)) {
    return some(showCompletions(builtIn2.completions.value));
  }
  if (isSome(builtIn2.logLevel)) {
    return some(setLogLevel(builtIn2.logLevel.value));
  }
  if (builtIn2.help) {
    return some(showHelp(usage, helpDoc));
  }
  if (builtIn2.wizard) {
    return some(showWizard(command));
  }
  if (builtIn2.version) {
    return some(showVersion);
  }
  return none();
});

// node_modules/@effect/cli/dist/esm/HelpDoc.js
var p2 = p;

// node_modules/@effect/cli/dist/esm/Options.js
var Options_exports = {};
__export(Options_exports, {
  OptionsTypeId: () => OptionsTypeId2,
  all: () => all3,
  atLeast: () => atLeast2,
  atMost: () => atMost2,
  between: () => between2,
  boolean: () => boolean4,
  choice: () => choice3,
  choiceWithValue: () => choiceWithValue2,
  date: () => date4,
  directory: () => directory2,
  file: () => file3,
  fileContent: () => fileContent2,
  fileParse: () => fileParse2,
  fileSchema: () => fileSchema2,
  fileText: () => fileText2,
  filterMap: () => filterMap3,
  float: () => float4,
  getHelp: () => getHelp5,
  getIdentifier: () => getIdentifier2,
  getUsage: () => getUsage3,
  integer: () => integer4,
  isBool: () => isBool3,
  isOptions: () => isOptions2,
  keyValueMap: () => keyValueMap2,
  map: () => map11,
  mapEffect: () => mapEffect3,
  mapTryCatch: () => mapTryCatch2,
  none: () => none5,
  optional: () => optional3,
  orElse: () => orElse6,
  orElseEither: () => orElseEither2,
  parse: () => parse6,
  processCommandLine: () => processCommandLine2,
  redacted: () => redacted3,
  repeated: () => repeated3,
  secret: () => secret3,
  text: () => text8,
  withAlias: () => withAlias2,
  withDefault: () => withDefault2,
  withDescription: () => withDescription2,
  withFallbackConfig: () => withFallbackConfig2,
  withFallbackPrompt: () => withFallbackPrompt2,
  withPseudoName: () => withPseudoName2,
  withSchema: () => withSchema2,
  wizard: () => wizard4
});
var OptionsTypeId2 = OptionsTypeId;
var isOptions2 = isOptions;
var all3 = all2;
var boolean4 = boolean3;
var choice3 = choice2;
var choiceWithValue2 = choiceWithValue;
var date4 = date3;
var directory2 = directory;
var file3 = file2;
var fileContent2 = fileContent;
var fileParse2 = fileParse;
var fileSchema2 = fileSchema;
var fileText2 = fileText;
var float4 = float3;
var getHelp5 = getHelp4;
var getIdentifier2 = getIdentifier;
var getUsage3 = getUsage2;
var integer4 = integer3;
var keyValueMap2 = keyValueMap;
var none5 = none4;
var redacted3 = redacted2;
var secret3 = secret2;
var text8 = text7;
var atMost2 = atMost;
var atLeast2 = atLeast;
var between2 = between;
var filterMap3 = filterMap2;
var isBool3 = isBool2;
var map11 = map10;
var mapEffect3 = mapEffect2;
var mapTryCatch2 = mapTryCatch;
var optional3 = optional2;
var orElse6 = orElse4;
var orElseEither2 = orElseEither;
var parse6 = parse5;
var repeated3 = repeated2;
var processCommandLine2 = processCommandLine;
var withAlias2 = withAlias;
var withDefault2 = withDefault;
var withFallbackConfig2 = withFallbackConfig;
var withFallbackPrompt2 = withFallbackPrompt;
var withDescription2 = withDescription;
var withPseudoName2 = withPseudoName;
var withSchema2 = withSchema;
var wizard4 = wizard3;

// node_modules/@effect/cli/dist/esm/internal/commandDirective.js
var builtIn = (option) => ({
  _tag: "BuiltIn",
  option
});
var userDefined = (leftover, value2) => ({
  _tag: "UserDefined",
  leftover,
  value: value2
});
var isBuiltIn = (self) => self._tag === "BuiltIn";
var isUserDefined = (self) => self._tag === "UserDefined";

// node_modules/@effect/cli/dist/esm/internal/commandDescriptor.js
var CommandDescriptorSymbolKey = "@effect/cli/CommandDescriptor";
var TypeId = /* @__PURE__ */ Symbol.for(CommandDescriptorSymbolKey);
var proto10 = {
  [TypeId]: {
    _A: (_) => _
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var isCommand = (u) => typeof u === "object" && u != null && TypeId in u;
var isStandard = (self) => self._tag === "Standard";
var make8 = (name, options3 = none4, args = none3) => {
  const op = Object.create(proto10);
  op._tag = "Standard";
  op.name = name;
  op.description = empty7;
  op.options = options3;
  op.args = args;
  return op;
};
var prompt = (name, prompt4) => {
  const op = Object.create(proto10);
  op._tag = "GetUserInput";
  op.name = name;
  op.description = empty7;
  op.prompt = prompt4;
  return op;
};
var getHelp6 = (self, config) => getHelpInternal4(self, config);
var getNames2 = (self) => fromIterable2(getNamesInternal(self));
var getBashCompletions3 = (self, executable) => getBashCompletionsInternal(self, executable);
var getFishCompletions4 = (self, executable) => getFishCompletionsInternal(self, executable);
var getZshCompletions4 = (self, executable) => getZshCompletionsInternal(self, executable);
var getSubcommands = (self) => fromIterable3(getSubcommandsInternal(self));
var getUsage4 = (self) => getUsageInternal3(self);
var map12 = /* @__PURE__ */ dual(2, (self, f) => mapEffect4(self, (a) => right(f(a))));
var mapEffect4 = /* @__PURE__ */ dual(2, (self, f) => {
  const op = Object.create(proto10);
  op._tag = "Map";
  op.command = self;
  op.f = f;
  return op;
});
var parse7 = /* @__PURE__ */ dual(3, (self, args, config) => parseInternal2(self, args, config));
var withDescription3 = /* @__PURE__ */ dual(2, (self, help) => withDescriptionInternal(self, help));
var withSubcommands = /* @__PURE__ */ dual(2, (self, subcommands) => {
  const op = Object.create(proto10);
  op._tag = "Subcommands";
  op.parent = self;
  op.children = map2(subcommands, ([id, command]) => map12(command, (a) => [id, a]));
  return op;
});
var wizard5 = /* @__PURE__ */ dual(3, (self, prefix, config) => wizardInternal4(self, prefix, config));
var getHelpInternal4 = (self, config) => {
  switch (self._tag) {
    case "Standard": {
      const header = isEmpty5(self.description) ? empty7 : sequence(h1("DESCRIPTION"), self.description);
      const argsHelp = getHelp3(self.args);
      const argsSection = isEmpty5(argsHelp) ? empty7 : sequence(h1("ARGUMENTS"), argsHelp);
      const options3 = config.showBuiltIns ? all3([self.options, builtIns]) : self.options;
      const optionsHelp = getHelp4(options3);
      const optionsSection = isEmpty5(optionsHelp) ? empty7 : sequence(h1("OPTIONS"), optionsHelp);
      return sequence(header, sequence(argsSection, optionsSection));
    }
    case "GetUserInput": {
      return isEmpty5(self.description) ? empty7 : sequence(h1("DESCRIPTION"), self.description);
    }
    case "Map": {
      return getHelpInternal4(self.command, config);
    }
    case "Subcommands": {
      const getUsage7 = (command, preceding) => {
        switch (command._tag) {
          case "Standard":
          case "GetUserInput": {
            const usage = getSpan(getHelp2(getUsageInternal3(command)));
            const usages = append(preceding, usage);
            const finalUsage = reduce(usages, empty6, (acc, next) => isText3(acc) && acc.value === "" ? next : isText3(next) && next.value === "" ? acc : spans([acc, space3, next]));
            const description = getSpan(command.description);
            return of([finalUsage, description]);
          }
          case "Map": {
            return getUsage7(command.command, preceding);
          }
          case "Subcommands": {
            const parentUsage = getUsage7(command.parent, preceding);
            return match(head(parentUsage), {
              onNone: () => flatMap2(command.children, (child) => getUsage7(child, preceding)),
              onSome: ([usage]) => {
                const childrenUsage = flatMap2(command.children, (child) => getUsage7(child, append(preceding, usage)));
                return appendAll(parentUsage, childrenUsage);
              }
            });
          }
        }
      };
      const printSubcommands = (subcommands) => {
        const maxUsageLength = reduceRight(subcommands, 0, (max2, [usage]) => Math.max(size(usage), max2));
        const documents = map2(subcommands, ([usage, desc]) => p(spans([usage, text4(" ".repeat(maxUsageLength - size(usage) + 2)), desc])));
        if (isNonEmptyReadonlyArray(documents)) {
          return enumeration(documents);
        }
        throw new Error("[BUG]: Subcommands.usage - received empty list of subcommands to print");
      };
      return sequence(getHelpInternal4(self.parent, config), sequence(h1("COMMANDS"), printSubcommands(flatMap2(self.children, (child) => getUsage7(child, empty())))));
    }
  }
};
var getNamesInternal = (self) => {
  switch (self._tag) {
    case "Standard":
    case "GetUserInput": {
      return of(self.name);
    }
    case "Map": {
      return getNamesInternal(self.command);
    }
    case "Subcommands": {
      return getNamesInternal(self.parent);
    }
  }
};
var getSubcommandsInternal = (self) => {
  const loop = (self2, isSubcommand) => {
    switch (self2._tag) {
      case "Standard":
      case "GetUserInput": {
        return of([self2.name, self2]);
      }
      case "Map": {
        return loop(self2.command, isSubcommand);
      }
      case "Subcommands": {
        return isSubcommand ? loop(self2.parent, false) : flatMap2(self2.children, (child) => loop(child, true));
      }
    }
  };
  return loop(self, false);
};
var getUsageInternal3 = (self) => {
  switch (self._tag) {
    case "Standard": {
      return concat2(named(of(self.name), none()), concat2(getUsage2(self.options), getUsage(self.args)));
    }
    case "GetUserInput": {
      return named(of(self.name), none());
    }
    case "Map": {
      return getUsageInternal3(self.command);
    }
    case "Subcommands": {
      return concat2(getUsageInternal3(self.parent), mixed);
    }
  }
};
var parseInternal2 = (self, args, config) => {
  const parseCommandLine2 = (self2, args2) => matchLeft(args2, {
    onEmpty: () => {
      const error3 = p(`Missing command name: '${self2.name}'`);
      return fail2$1(commandMismatch(error3));
    },
    onNonEmpty: (head2, tail) => {
      const normalizedArgv0 = normalizeCase(config, head2);
      const normalizedCommandName = normalizeCase(config, self2.name);
      return succeed(tail).pipe(when(() => normalizedArgv0 === normalizedCommandName), flatten, catchTag("NoSuchElementException", () => {
        const error3 = p(`Missing command name: '${self2.name}'`);
        return fail2$1(commandMismatch(error3));
      }));
    }
  });
  switch (self._tag) {
    case "Standard": {
      const parseBuiltInArgs = (args2) => matchLeft(args2, {
        onEmpty: () => {
          const error3 = p(`Missing command name: '${self.name}'`);
          return fail2$1(commandMismatch(error3));
        },
        onNonEmpty: (argv0) => {
          const normalizedArgv0 = normalizeCase(config, argv0);
          const normalizedCommandName = normalizeCase(config, self.name);
          if (normalizedArgv0 === normalizedCommandName) {
            const help = getHelpInternal4(self, config);
            const usage = getUsageInternal3(self);
            const options3 = builtInOptions(self, usage, help);
            const argsWithoutCommand = drop(args2, 1);
            return processCommandLine(options3, argsWithoutCommand, config).pipe(flatMap3((tuple3) => tuple3[2]), catchTag("NoSuchElementException", () => {
              const error4 = p("No built-in option was matched");
              return fail2$1(noBuiltInMatch(error4));
            }), map3(builtIn));
          }
          const error3 = p(`Missing command name: '${self.name}'`);
          return fail2$1(commandMismatch(error3));
        }
      });
      const parseUserDefinedArgs = (args2) => parseCommandLine2(self, args2).pipe(flatMap3((commandOptionsAndArgs) => {
        const [optionsAndArgs, forcedCommandArgs] = splitForcedArgs(commandOptionsAndArgs);
        return processCommandLine(self.options, optionsAndArgs, config).pipe(flatMap3(([error3, commandArgs, optionsType]) => validate2(self.args, appendAll(commandArgs, forcedCommandArgs), config).pipe(catchAll((e) => match(error3, {
          onNone: () => fail2$1(e),
          onSome: (err) => fail2$1(err)
        })), map3(([argsLeftover, argsType]) => userDefined(argsLeftover, {
          name: self.name,
          options: optionsType,
          args: argsType
        })))));
      }));
      const exhaustiveSearch = (args2) => {
        if (contains(args2, "--help") || contains(args2, "-h")) {
          return parseBuiltInArgs(make(self.name, "--help"));
        }
        if (contains(args2, "--wizard")) {
          return parseBuiltInArgs(make(self.name, "--wizard"));
        }
        if (contains(args2, "--version")) {
          return parseBuiltInArgs(make(self.name, "--version"));
        }
        const error3 = p(`Missing command name: '${self.name}'`);
        return fail2$1(commandMismatch(error3));
      };
      return parseBuiltInArgs(args).pipe(orElse2(() => parseUserDefinedArgs(args)), catchSome((e) => {
        if (isValidationError(e)) {
          if (config.finalCheckBuiltIn) {
            return some(exhaustiveSearch(args).pipe(catchSome((_) => isValidationError(_) ? some(fail2$1(e)) : none())));
          }
          return some(fail2$1(e));
        }
        return none();
      }));
    }
    case "GetUserInput": {
      return parseCommandLine2(self, args).pipe(zipRight(run(self.prompt)), catchTag("QuitException", (e) => die(e)), map3((value2) => userDefined(drop(args, 1), {
        name: self.name,
        value: value2
      })));
    }
    case "Map": {
      return parseInternal2(self.command, args, config).pipe(flatMap3((directive) => {
        if (isUserDefined(directive)) {
          return self.f(directive.value).pipe(map3((value2) => userDefined(directive.leftover, value2)));
        }
        return succeed(directive);
      }));
    }
    case "Subcommands": {
      const names = getNamesInternal(self);
      const subcommands = getSubcommandsInternal(self);
      const [parentArgs, childArgs] = span(args, (arg) => !some2(subcommands, ([name]) => name === arg));
      const parseChildrenWith = (argsForChildren) => suspend(() => {
        const iterator = self.children[Symbol.iterator]();
        const loop = (next) => {
          return parseInternal2(next, argsForChildren, config).pipe(catchIf(isCommandMismatch, (e) => {
            const next2 = iterator.next();
            return next2.done ? fail2$1(e) : loop(next2.value);
          }));
        };
        return loop(iterator.next().value);
      });
      const parseChildren = parseChildrenWith(childArgs);
      const helpDirectiveForParent = sync(() => {
        return builtIn(showHelp(getUsageInternal3(self), getHelpInternal4(self, config)));
      });
      const helpDirectiveForChild = parseChildren.pipe(flatMap3((directive) => {
        if (isBuiltIn(directive) && isShowHelp(directive.option)) {
          const parentName = getOrElse(head(names), () => "");
          const newDirective = builtIn(showHelp(concat2(named(of(parentName), none()), directive.option.usage), directive.option.helpDoc));
          return succeed(newDirective);
        }
        return fail2$1(invalidArgument(empty7));
      }));
      const wizardDirectiveForParent = sync(() => builtIn(showWizard(self)));
      const wizardDirectiveForChild = parseChildren.pipe(flatMap3((directive) => {
        if (isBuiltIn(directive) && isShowWizard(directive.option)) {
          return succeed(directive);
        }
        return fail2$1(invalidArgument(empty7));
      }));
      return suspend(() => parseInternal2(self.parent, parentArgs, config).pipe(flatMap3((directive) => {
        switch (directive._tag) {
          case "BuiltIn": {
            if (isShowHelp(directive.option)) {
              return isNonEmptyReadonlyArray(childArgs) ? orElse2(helpDirectiveForChild, () => helpDirectiveForParent) : helpDirectiveForParent;
            }
            if (isShowWizard(directive.option)) {
              return orElse2(wizardDirectiveForChild, () => wizardDirectiveForParent);
            }
            return succeed(directive);
          }
          case "UserDefined": {
            const args2 = appendAll(directive.leftover, childArgs);
            if (isNonEmptyReadonlyArray(args2)) {
              return parseChildrenWith(args2).pipe(flatMap3((childDirective) => {
                if (!isUserDefined(childDirective)) {
                  return succeed(childDirective);
                }
                const childLeftover = childDirective.leftover;
                if (isEmptyReadonlyArray(childLeftover)) {
                  return succeed(userDefined(childLeftover, {
                    ...directive.value,
                    subcommand: some(childDirective.value)
                  }));
                }
                const parentArgsWithLeftover = appendAll(parentArgs, childLeftover);
                return parseInternal2(self.parent, parentArgsWithLeftover, config).pipe(flatMap3((reParsedParentDirective) => {
                  if (!isUserDefined(reParsedParentDirective)) {
                    return succeed(userDefined(childLeftover, {
                      ...directive.value,
                      subcommand: some(childDirective.value)
                    }));
                  }
                  return succeed(userDefined(reParsedParentDirective.leftover, {
                    ...reParsedParentDirective.value,
                    subcommand: some(childDirective.value)
                  }));
                }), catchAll(() => succeed(userDefined(childLeftover, {
                  ...directive.value,
                  subcommand: some(childDirective.value)
                }))));
              }), catchAll((err) => {
                if (isCommandMismatch(err)) {
                  const parentName = getOrElse(head(names), () => "");
                  const childNames = map2(subcommands, ([name]) => `'${name}'`);
                  const oneOf = childNames.length === 1 ? "" : " one of";
                  const error3 = p(`Invalid subcommand for ${parentName} - use${oneOf} ${join$1(childNames, ", ")}`);
                  return fail2$1(commandMismatch(error3));
                }
                return fail2$1(err);
              }));
            }
            return succeed(userDefined(directive.leftover, {
              ...directive.value,
              subcommand: none()
            }));
          }
        }
      }), catchSome(() => isEmptyReadonlyArray(args) ? some(helpDirectiveForParent) : none())));
    }
  }
};
var splitForcedArgs = (args) => {
  const [remainingArgs, forcedArgs] = span(args, (str) => str !== "--");
  return [remainingArgs, drop(forcedArgs, 1)];
};
var withDescriptionInternal = (self, description) => {
  switch (self._tag) {
    case "Standard": {
      const helpDoc = typeof description === "string" ? p2(description) : description;
      const op = Object.create(proto10);
      op._tag = "Standard";
      op.name = self.name;
      op.description = helpDoc;
      op.options = self.options;
      op.args = self.args;
      return op;
    }
    case "GetUserInput": {
      const helpDoc = typeof description === "string" ? p2(description) : description;
      const op = Object.create(proto10);
      op._tag = "GetUserInput";
      op.name = self.name;
      op.description = helpDoc;
      op.prompt = self.prompt;
      return op;
    }
    case "Map": {
      return mapEffect4(withDescriptionInternal(self.command, description), self.f);
    }
    case "Subcommands": {
      const op = Object.create(proto10);
      op._tag = "Subcommands";
      op.parent = withDescriptionInternal(self.parent, description);
      op.children = self.children.slice();
      return op;
    }
  }
};
var argsWizardHeader = /* @__PURE__ */ code("Args Wizard - ");
var optionsWizardHeader = /* @__PURE__ */ code("Options Wizard - ");
var wizardInternal4 = (self, prefix, config) => {
  const loop = (self2, commandLineRef) => {
    switch (self2._tag) {
      case "GetUserInput":
      case "Standard": {
        return gen(function* () {
          const logCurrentCommand = get2(commandLineRef).pipe(flatMap3((commandLine) => {
            const currentCommand = p(pipe(strong(highlight("COMMAND:", cyan3)), concat(space3), concat(highlight(join$1(commandLine, " "), magenta3))));
            return log(toAnsiText(currentCommand));
          }));
          if (isStandard(self2)) {
            yield* logCurrentCommand;
            const commandName = highlight(self2.name, magenta3);
            if (!isEmpty7(self2.options)) {
              const message = p(concat(optionsWizardHeader, commandName));
              yield* log(toAnsiText(message));
              const options3 = yield* wizard3(self2.options, config);
              yield* updateAndGet(commandLineRef, appendAll(options3));
              yield* logCurrentCommand;
            }
            if (!isEmpty6(self2.args)) {
              const message = p(concat(argsWizardHeader, commandName));
              yield* log(toAnsiText(message));
              const options3 = yield* wizard2(self2.args, config);
              yield* updateAndGet(commandLineRef, appendAll(options3));
              yield* logCurrentCommand;
            }
          }
          return yield* get2(commandLineRef);
        });
      }
      case "Map": {
        return loop(self2.command, commandLineRef);
      }
      case "Subcommands": {
        const description = p("Select which command you would like to execute");
        const message = toAnsiText(description).trimEnd();
        const makeChoice = (title, index) => ({
          title,
          value: [title, index]
        });
        const choices = pipe(getSubcommandsInternal(self2), map2(([name], index) => makeChoice(name, index)));
        return loop(self2.parent, commandLineRef).pipe(zipRight(select({
          message,
          choices
        }).pipe(tap(([name]) => update(commandLineRef, append(name))), zipLeft(log()), flatMap3(([, nextIndex]) => loop(self2.children[nextIndex], commandLineRef)))));
      }
    }
  };
  return make4(prefix).pipe(flatMap3((commandLineRef) => loop(self, commandLineRef).pipe(zipRight(get2(commandLineRef)))));
};
var getShortDescription3 = (self) => {
  switch (self._tag) {
    case "Standard": {
      return getText(getSpan(self.description));
    }
    case "GetUserInput": {
      return getText(getSpan(self.description));
    }
    case "Map": {
      return getShortDescription3(self.command);
    }
    case "Subcommands": {
      return "";
    }
  }
};
var traverseCommand = (self, initialState3, f) => make10$1(initialState3).pipe(flatMap3((ref) => {
  const loop = (self2, parentCommands, subcommands, level) => {
    switch (self2._tag) {
      case "Standard": {
        const info = {
          command: self2,
          parentCommands,
          subcommands,
          level
        };
        return updateEffect(ref, (state) => f(state, info));
      }
      case "GetUserInput": {
        const info = {
          command: self2,
          parentCommands,
          subcommands,
          level
        };
        return updateEffect(ref, (state) => f(state, info));
      }
      case "Map": {
        return loop(self2.command, parentCommands, subcommands, level);
      }
      case "Subcommands": {
        const parentNames = getNamesInternal(self2.parent);
        const nextSubcommands = getSubcommandsInternal(self2);
        const nextParentCommands = appendAll(parentCommands, parentNames);
        return loop(self2.parent, parentCommands, nextSubcommands, level).pipe(zipRight(forEach(self2.children, (child) => (
          // Traverse the child command using next parent names and old subcommands
          loop(child, nextParentCommands, subcommands, level + 1)
        ))));
      }
    }
  };
  return suspend(() => loop(self, empty(), empty(), 0)).pipe(zipRight(get4(ref)));
}));
var indentAll = /* @__PURE__ */ dual(2, (self, indent3) => {
  const indentation = allocate(indent3 + 1).join(" ");
  return map2(self, (line4) => `${indentation}${line4}`);
});
var getBashCompletionsInternal = (self, executable) => traverseCommand(self, empty(), (state, info) => {
  const options3 = isStandard(info.command) ? all3([info.command.options, builtIns]) : builtIns;
  const optionNames = getNames(options3);
  const optionCases = isStandard(info.command) ? getBashCompletions2(info.command.options) : empty();
  const subcommandNames = pipe(info.subcommands, map2(([name]) => name), sort(string2));
  const wordList = appendAll(optionNames, subcommandNames);
  const preformatted = isEmptyReadonlyArray(info.parentCommands) ? of(info.command.name) : pipe(info.parentCommands, append(info.command.name), map2((command) => command.replace("-", "__")));
  const caseName = join$1(preformatted, ",");
  const funcName = join$1(preformatted, "__");
  const funcLines = isEmptyReadonlyArray(info.parentCommands) ? empty() : [`${caseName})`, `    cmd="${funcName}"`, "    ;;"];
  const cmdLines = [`${funcName})`, `    opts="${join$1(wordList, " ")}"`, `    if [[ \${cur} == -* || \${COMP_CWORD} -eq ${info.level + 1} ]] ; then`, '        COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )', "        return 0", "    fi", '    case "${prev}" in', ...indentAll(optionCases, 8), "    *)", "        COMPREPLY=()", "        ;;", "    esac", '    COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )', "    return 0", "    ;;"];
  const lines2 = append(state, [funcLines, cmdLines]);
  return succeed(lines2);
}).pipe(map3((lines2) => {
  const rootCommand2 = unsafeGet(getNamesInternal(self), 0);
  const scriptName = `_${rootCommand2}_bash_completions`;
  const funcCases = flatMap2(lines2, ([funcLines]) => funcLines);
  const cmdCases = flatMap2(lines2, ([, cmdLines]) => cmdLines);
  return [`function ${scriptName}() {`, "    local i cur prev opts cmd", "    COMPREPLY=()", '    cur="${COMP_WORDS[COMP_CWORD]}"', '    prev="${COMP_WORDS[COMP_CWORD-1]}"', '    cmd=""', '    opts=""', '    for i in "${COMP_WORDS[@]}"; do', '        case "${cmd},${i}" in', '            ",$1")', `                cmd="${executable}"`, "                ;;", ...indentAll(funcCases, 12), "            *)", "                ;;", "        esac", "    done", '    case "${cmd}" in', ...indentAll(cmdCases, 8), "    esac", "}", `complete -F ${scriptName} -o nosort -o bashdefault -o default ${rootCommand2}`];
}));
var getFishCompletionsInternal = (self, executable) => traverseCommand(self, empty(), (state, info) => {
  const baseTemplate = make("complete", "-c", executable);
  const options3 = isStandard(info.command) ? all2([builtIns, info.command.options]) : builtIns;
  const optionsCompletions = getFishCompletions3(options3);
  const argsCompletions = isStandard(info.command) ? getFishCompletions2(info.command.args) : empty();
  const rootCompletions = (conditionals2) => pipe(map2(optionsCompletions, (option) => pipe(baseTemplate, appendAll(conditionals2), append(option), join$1(" "))), appendAll(map2(argsCompletions, (option) => pipe(baseTemplate, appendAll(conditionals2), append(option), join$1(" ")))));
  const subcommandCompletions = (conditionals2) => map2(info.subcommands, ([name, subcommand]) => {
    const description = getShortDescription3(subcommand);
    return pipe(baseTemplate, appendAll(conditionals2), appendAll(make("-f", "-a", `"${name}"`)), appendAll(description.length === 0 ? empty() : make("-d", `'${description}'`)), join$1(" "));
  });
  if (isEmptyReadonlyArray(info.parentCommands)) {
    const conditionals2 = make("-n", '"__fish_use_subcommand"');
    return succeed(pipe(state, appendAll(rootCompletions(conditionals2)), appendAll(subcommandCompletions(conditionals2))));
  }
  const parentConditionals = pipe(
    info.parentCommands,
    // Drop the root command name from the subcommand conditionals
    drop(1),
    append(info.command.name),
    map2((command) => `__fish_seen_subcommand_from ${command}`)
  );
  const subcommandConditionals = map2(info.subcommands, ([name]) => `not __fish_seen_subcommand_from ${name}`);
  const baseConditionals = pipe(appendAll(parentConditionals, subcommandConditionals), join$1("; and "));
  const conditionals = make("-n", `"${baseConditionals}"`);
  return succeed(pipe(state, appendAll(rootCompletions(conditionals)), appendAll(subcommandCompletions(conditionals))));
});
var getZshCompletionsInternal = (self, executable) => traverseCommand(self, empty(), (state, info) => {
  const preformatted = isEmptyReadonlyArray(info.parentCommands) ? of(info.command.name) : pipe(info.parentCommands, append(info.command.name), map2((command) => command.replace("-", "__")));
  const underscoreName = join$1(preformatted, "__");
  const spaceName = join$1(preformatted, " ");
  const subcommands = pipe(info.subcommands, map2(([name, subcommand]) => {
    const desc = getShortDescription3(subcommand);
    return `'${name}:${desc}' \\`;
  }));
  const commands = isEmptyReadonlyArray(subcommands) ? `commands=()` : `commands=(
${join$1(indentAll(subcommands, 8), "\n")}
    )`;
  const handlerLines = [`(( $+functions[_${underscoreName}_commands] )) ||`, `_${underscoreName}_commands() {`, `    local commands; ${commands}`, `    _describe -t commands '${spaceName} commands' commands "$@"`, "}"];
  return succeed(appendAll(state, handlerLines));
}).pipe(map3((handlers) => {
  const rootCommand2 = unsafeGet(getNamesInternal(self), 0);
  const cases = getZshSubcommandCases(self, empty(), empty());
  const scriptName = `_${rootCommand2}_zsh_completions`;
  return [`#compdef ${executable}`, "", "autoload -U is-at-least", "", `function ${scriptName}() {`, "    typeset -A opt_args", "    typeset -a _arguments_options", "    local ret=1", "", "    if is-at-least 5.2; then", "        _arguments_options=(-s -S -C)", "    else", "        _arguments_options=(-s -C)", "    fi", "", '    local context curcontext="$curcontext" state line', ...indentAll(cases, 4), "}", "", ...handlers, "", `if [ "$funcstack[1]" = "${scriptName}" ]; then`, `    ${scriptName} "$@"`, "else", `    compdef ${scriptName} ${rootCommand2}`, "fi"];
}));
var getZshSubcommandCases = (self, parentCommands, subcommands) => {
  switch (self._tag) {
    case "Standard":
    case "GetUserInput": {
      const options3 = isStandard(self) ? all2([builtIns, self.options]) : builtIns;
      const args = isStandard(self) ? self.args : none3;
      const optionCompletions = pipe(getZshCompletions3(options3), map2((completion) => `'${completion}' \\`));
      const argCompletions = pipe(getZshCompletions2(args), map2((completion) => `'${completion}' \\`));
      if (isEmptyReadonlyArray(parentCommands)) {
        return ['_arguments "${_arguments_options[@]}" \\', ...indentAll(optionCompletions, 4), ...indentAll(argCompletions, 4), `    ":: :_${self.name}_commands" \\`, `    "*::: :->${self.name}" \\`, "    && ret=0"];
      }
      if (isEmptyReadonlyArray(subcommands)) {
        return [`(${self.name})`, '_arguments "${_arguments_options[@]}" \\', ...indentAll(optionCompletions, 4), ...indentAll(argCompletions, 4), "    && ret=0", ";;"];
      }
      return [`(${self.name})`, '_arguments "${_arguments_options[@]}" \\', ...indentAll(optionCompletions, 4), ...indentAll(argCompletions, 4), `    ":: :_${append(parentCommands, self.name).join("__")}_commands" \\`, `    "*::: :->${self.name}" \\`, "    && ret=0"];
    }
    case "Map": {
      return getZshSubcommandCases(self.command, parentCommands, subcommands);
    }
    case "Subcommands": {
      const nextSubcommands = getSubcommandsInternal(self);
      const parentNames = getNamesInternal(self.parent);
      const parentLines = getZshSubcommandCases(self.parent, parentCommands, appendAll(subcommands, nextSubcommands));
      const childCases = pipe(self.children, flatMap2((child) => getZshSubcommandCases(child, appendAll(parentCommands, parentNames), subcommands)));
      const hyphenName = pipe(appendAll(parentCommands, parentNames), join$1("-"));
      const childLines = pipe(parentNames, flatMap2((parentName) => ["case $state in", `    (${parentName})`, `    words=($line[1] "\${words[@]}")`, "    (( CURRENT += 1 ))", `    curcontext="\${curcontext%:*:*}:${hyphenName}-command-$line[1]:"`, `    case $line[1] in`, ...indentAll(childCases, 8), "    esac", "    ;;", "esac"]), appendAll(isEmptyReadonlyArray(parentCommands) ? empty() : of(";;")));
      return appendAll(parentLines, childLines);
    }
  }
};
var helpRequestedError = (command) => {
  const op = Object.create(proto7);
  op._tag = "HelpRequested";
  op.error = empty7;
  op.command = command;
  return op;
};

// node_modules/@effect/cli/dist/esm/internal/cliApp.js
var proto11 = {
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var make9 = (config) => {
  const op = Object.create(proto11);
  op.name = config.name;
  op.version = config.version;
  op.executable = config.executable;
  op.command = config.command;
  op.summary = config.summary || empty6;
  op.footer = config.footer || empty7;
  return op;
};
var run2 = /* @__PURE__ */ dual(3, (self, args, execute) => contextWithEffect((context) => {
  const config = getOrElse(getOption(context, Tag), () => defaultConfig);
  const [executable, filteredArgs] = splitExecutable(self, args);
  const prefixedArgs = appendAll(prefixCommand(self.command), filteredArgs);
  return matchEffect(parse7(self.command, prefixedArgs, config), {
    onFailure: (e) => zipRight(printDocs(e.error), fail2$1(e)),
    onSuccess: unify((directive) => {
      switch (directive._tag) {
        case "UserDefined": {
          return matchLeft(directive.leftover, {
            onEmpty: () => execute(directive.value).pipe(catchSome((e) => isValidationError(e) && isHelpRequested(e) ? some(handleBuiltInOption(self, executable, filteredArgs, showHelp(getUsage4(e.command), getHelp6(e.command, config)), execute, config, args)) : none())),
            onNonEmpty: (head2) => {
              const error3 = p(`Received unknown argument: '${head2}'`);
              return zipRight(printDocs(error3), fail2$1(invalidValue(error3)));
            }
          });
        }
        case "BuiltIn": {
          return handleBuiltInOption(self, executable, filteredArgs, directive.option, execute, config, args).pipe(catchSome((e) => isValidationError(e) ? some(zipRight(printDocs(e.error), fail2$1(e))) : none()));
        }
      }
    })
  });
}));
var splitExecutable = (self, args) => {
  if (self.executable !== void 0) {
    return [self.executable, drop(args, 2)];
  }
  const [[runtime, script], optionsAndArgs] = splitAt(args, 2);
  return [`${runtime} ${script}`, optionsAndArgs];
};
var printDocs = (error3) => error(toAnsiText(error3));
var handleBuiltInOption = (self, executable, args, builtIn2, execute, config, originalArgs) => {
  switch (builtIn2._tag) {
    case "SetLogLevel": {
      const baseArgs = take(originalArgs, 2);
      const filteredArgs = [];
      for (let i = 0; i < args.length; i++) {
        if (isLogLevelArg(args[i]) || isLogLevelArg(args[i - 1])) {
          continue;
        }
        filteredArgs.push(args[i]);
      }
      const nextArgs = appendAll(baseArgs, filteredArgs);
      return run2(self, nextArgs, execute).pipe(withMinimumLogLevel(builtIn2.level));
    }
    case "ShowHelp": {
      const banner = h1(code(self.name));
      const header = p(spans([text4(`${self.name} ${self.version}`), isEmpty4(self.summary) ? empty6 : spans([space3, text4("--"), space3, self.summary])]));
      const usage = sequence(h1("USAGE"), pipe(enumerate(builtIn2.usage, config), map2((span2) => p(concat(text4("$ "), span2))), reduceRight(empty7, (left2, right2) => sequence(left2, right2))));
      const helpDoc = pipe(banner, sequence(header), sequence(usage), sequence(builtIn2.helpDoc), sequence(self.footer));
      return log(toAnsiText(helpDoc));
    }
    case "ShowCompletions": {
      const command = fromIterable(getNames2(self.command))[0];
      switch (builtIn2.shellType) {
        case "bash": {
          return getBashCompletions3(self.command, command).pipe(flatMap3((completions) => log(join$1(completions, "\n"))));
        }
        case "fish": {
          return getFishCompletions4(self.command, command).pipe(flatMap3((completions) => log(join$1(completions, "\n"))));
        }
        case "zsh":
          return getZshCompletions4(self.command, command).pipe(flatMap3((completions) => log(join$1(completions, "\n"))));
      }
    }
    case "ShowWizard": {
      const summary = isEmpty4(self.summary) ? empty6 : spans([space3, text4("--"), space3, self.summary]);
      const instructions = sequence(p(spans([text4("The wizard mode will assist you with constructing commands for"), space3, code(`${self.name} (${self.version})`), text4(".")])), p("Please answer all prompts provided by the wizard."));
      const description = descriptionList([[text4("Instructions"), instructions]]);
      const header = h1(spans([code("Wizard Mode for CLI Application:"), space3, code(self.name), space3, code(`(${self.version})`), summary]));
      const help = sequence(header, description);
      const text9 = toAnsiText(help);
      const command = fromIterable(getNames2(self.command))[0];
      const wizardPrefix = getWizardPrefix(builtIn2, command, args);
      return log(text9).pipe(zipRight(wizard5(builtIn2.command, wizardPrefix, config)), tap((args2) => log(toAnsiText(renderWizardArgs(args2)))), flatMap3((args2) => toggle({
        message: "Would you like to run the command?",
        initial: true,
        active: "yes",
        inactive: "no"
      }).pipe(flatMap3((shouldRunCommand) => {
        const baseArgs = take(originalArgs, 2);
        const wizardArgs = drop(args2, 1);
        const finalArgs = appendAll(baseArgs, wizardArgs);
        return shouldRunCommand ? log().pipe(zipRight(run2(self, finalArgs, execute))) : _void;
      }))), catchAll((e) => {
        if (isQuitException(e)) {
          const message = p(error2("\n\nQuitting wizard mode..."));
          return log(toAnsiText(message));
        }
        return fail2$1(e);
      }));
    }
    case "ShowVersion": {
      const help = p(self.version);
      return log(toAnsiText(help));
    }
  }
};
var prefixCommand = (self) => {
  let command = self;
  let prefix = empty();
  while (command !== void 0) {
    switch (command._tag) {
      case "Standard": {
        prefix = of(command.name);
        command = void 0;
        break;
      }
      case "GetUserInput": {
        prefix = of(command.name);
        command = void 0;
        break;
      }
      case "Map": {
        command = command.command;
        break;
      }
      case "Subcommands": {
        command = command.parent;
        break;
      }
    }
  }
  return prefix;
};
var getWizardPrefix = (builtIn2, rootCommand2, commandLineArgs) => {
  const subcommands = getSubcommands(builtIn2.command);
  const [parentArgs, childArgs] = span(commandLineArgs, (name) => !has(subcommands, name));
  const args = matchLeft(childArgs, {
    onEmpty: () => filter(parentArgs, (arg) => arg !== "--wizard"),
    onNonEmpty: (head2) => append(parentArgs, head2)
  });
  return appendAll(rootCommand2.split(/\s+/), args);
};
var renderWizardArgs = (args) => {
  const params = pipe(filter(args, (param) => param.length > 0), join$1(" "));
  const executeMsg = text4("You may now execute your command directly with the following options and arguments:");
  return blocks([p(strong(code("Wizard Mode Complete!"))), p(executeMsg), p(concat(text4("    "), highlight(params, cyan3)))]);
};
var isLogLevelArg = (arg) => {
  return arg && (arg === "--log-level" || arg.startsWith("--log-level="));
};

// node_modules/@effect/cli/dist/esm/Command.js
var Command_exports = {};
__export(Command_exports, {
  TypeId: () => TypeId3,
  fromDescriptor: () => fromDescriptor2,
  getBashCompletions: () => getBashCompletions5,
  getFishCompletions: () => getFishCompletions6,
  getHelp: () => getHelp8,
  getNames: () => getNames4,
  getSubcommands: () => getSubcommands3,
  getUsage: () => getUsage6,
  getZshCompletions: () => getZshCompletions6,
  make: () => make11,
  prompt: () => prompt3,
  provide: () => provide3,
  provideEffect: () => provideEffect2,
  provideEffectDiscard: () => provideEffectDiscard2,
  provideSync: () => provideSync2,
  run: () => run4,
  transformHandler: () => transformHandler2,
  withDescription: () => withDescription5,
  withHandler: () => withHandler2,
  withSubcommands: () => withSubcommands3,
  wizard: () => wizard7
});

// node_modules/@effect/cli/dist/esm/ValidationError.js
var helpRequested = helpRequestedError;

// node_modules/@effect/cli/dist/esm/internal/command.js
var CommandSymbolKey = "@effect/cli/Command";
var TypeId2 = /* @__PURE__ */ Symbol.for(CommandSymbolKey);
var parseConfig = (config) => {
  const args = [];
  let argsIndex = 0;
  const options3 = [];
  let optionsIndex = 0;
  function parse8(config2) {
    const tree = {};
    for (const key in config2) {
      tree[key] = parseValue(config2[key]);
    }
    return tree;
  }
  function parseValue(value2) {
    if (isArray(value2)) {
      return {
        _tag: "Array",
        children: map2(value2, parseValue)
      };
    } else if (isArgs(value2)) {
      args.push(value2);
      return {
        _tag: "Args",
        index: argsIndex++
      };
    } else if (isOptions(value2)) {
      options3.push(value2);
      return {
        _tag: "Options",
        index: optionsIndex++
      };
    } else {
      return {
        _tag: "ParsedConfig",
        tree: parse8(value2)
      };
    }
  }
  return {
    args,
    options: options3,
    tree: parse8(config)
  };
};
var reconstructConfigTree = (tree, args, options3) => {
  const output = {};
  for (const key in tree) {
    output[key] = nodeValue(tree[key]);
  }
  return output;
  function nodeValue(node) {
    if (node._tag === "Args") {
      return args[node.index];
    } else if (node._tag === "Options") {
      return options3[node.index];
    } else if (node._tag === "Array") {
      return map2(node.children, nodeValue);
    } else {
      return reconstructConfigTree(node.tree, args, options3);
    }
  }
};
var Prototype = {
  ...CommitPrototype,
  [TypeId2]: TypeId2,
  commit() {
    return this.tag;
  },
  pipe() {
    return pipeArguments(this, arguments);
  }
};
var registeredDescriptors = /* @__PURE__ */ globalValue("@effect/cli/Command/registeredDescriptors", () => /* @__PURE__ */ new WeakMap());
var getDescriptor = (self) => registeredDescriptors.get(self.tag) ?? self.descriptor;
var makeProto = (descriptor, handler, tag, transform = identity) => {
  const self = Object.create(Prototype);
  self.descriptor = descriptor;
  self.handler = handler;
  self.transform = transform;
  self.tag = tag;
  return self;
};
var makeDerive = (self, options3) => {
  const command = Object.create(Prototype);
  command.descriptor = options3.descriptor ?? self.descriptor;
  command.handler = options3.handler ?? self.handler;
  command.transform = options3.transform ? (effect, opts) => options3.transform(self.transform(effect, opts), opts) : self.transform;
  command.tag = self.tag;
  return command;
};
var fromDescriptor = /* @__PURE__ */ dual((args) => isCommand(args[0]), (descriptor, handler) => {
  const self = makeProto(descriptor, handler ?? ((_) => failSync(() => helpRequested(getDescriptor(self)))), GenericTag(`@effect/cli/Command/(${fromIterable(getNames2(descriptor)).join("|")})`));
  return self;
});
var makeDescriptor = (name, config) => {
  const {
    args,
    options: options3,
    tree
  } = parseConfig(config);
  return map12(make8(name, all2(options3), all(args)), ({
    args: args2,
    options: options4
  }) => reconstructConfigTree(tree, args2, options4));
};
var make10 = (name, config = {}, handler) => fromDescriptor(makeDescriptor(name, config), handler);
var getHelp7 = (self, config) => getHelp6(self.descriptor, config);
var getNames3 = (self) => getNames2(self.descriptor);
var getBashCompletions4 = (self, programName) => getBashCompletions3(self.descriptor, programName);
var getFishCompletions5 = (self, programName) => getFishCompletions4(self.descriptor, programName);
var getZshCompletions5 = (self, programName) => getZshCompletions4(self.descriptor, programName);
var getSubcommands2 = (self) => getSubcommands(self.descriptor);
var getUsage5 = (self) => getUsage4(self.descriptor);
var mapDescriptor = /* @__PURE__ */ dual(2, (self, f) => makeDerive(self, {
  descriptor: f(self.descriptor)
}));
var prompt2 = (name, prompt4, handler) => makeProto(map12(prompt(name, prompt4), (_) => _.value), handler, GenericTag(`@effect/cli/Prompt/${name}`));
var withHandler = /* @__PURE__ */ dual(2, (self, handler) => makeDerive(self, {
  handler,
  transform: identity
}));
var transformHandler = /* @__PURE__ */ dual(2, (self, f) => makeDerive(self, {
  transform: f
}));
var provide2 = /* @__PURE__ */ dual(2, (self, layer) => makeDerive(self, {
  transform: (effect, config) => provide(effect, typeof layer === "function" ? layer(config) : layer)
}));
var provideEffect = /* @__PURE__ */ dual(3, (self, tag, effect_) => makeDerive(self, {
  transform: (self2, config) => {
    const effect = typeof effect_ === "function" ? effect_(config) : effect_;
    return provideServiceEffect(self2, tag, effect);
  }
}));
var provideEffectDiscard = /* @__PURE__ */ dual(2, (self, effect_) => makeDerive(self, {
  transform: (self2, config) => {
    const effect = typeof effect_ === "function" ? effect_(config) : effect_;
    return zipRight(effect, self2);
  }
}));
var provideSync = /* @__PURE__ */ dual(3, (self, tag, f) => makeDerive(self, {
  transform: (self2, config) => {
    const service = typeof f === "function" ? f(config) : f;
    return provideService(self2, tag, service);
  }
}));
var withDescription4 = /* @__PURE__ */ dual(2, (self, help) => mapDescriptor(self, withDescription3(help)));
var withSubcommands2 = /* @__PURE__ */ dual(2, (self, subcommands) => {
  const command = withSubcommands(self.descriptor, map2(subcommands, (_) => [_.tag, _.descriptor]));
  const subcommandMap = reduce(subcommands, /* @__PURE__ */ new Map(), (handlers, subcommand) => {
    handlers.set(subcommand.tag, subcommand);
    registeredDescriptors.set(subcommand.tag, subcommand.descriptor);
    return handlers;
  });
  function handler(args) {
    if (args.subcommand._tag === "Some") {
      const [tag, value2] = args.subcommand.value;
      const subcommand = subcommandMap.get(tag);
      const subcommandEffect = subcommand.transform(subcommand.handler(value2), value2);
      return provideService(subcommandEffect, self.tag, args);
    }
    return self.handler(args);
  }
  return makeDerive(self, {
    descriptor: command,
    handler
  });
});
var wizard6 = /* @__PURE__ */ dual(3, (self, prefix, config) => wizard5(self.descriptor, prefix, config));
var run3 = /* @__PURE__ */ dual(2, (self, config) => {
  const app = make9({
    ...config,
    command: self.descriptor
  });
  registeredDescriptors.set(self.tag, self.descriptor);
  const handler = (args) => self.transform(self.handler(args), args);
  return (args) => run2(app, args, handler);
});

// node_modules/@effect/cli/dist/esm/Command.js
var TypeId3 = TypeId2;
var fromDescriptor2 = fromDescriptor;
var getHelp8 = getHelp7;
var getNames4 = getNames3;
var getBashCompletions5 = getBashCompletions4;
var getFishCompletions6 = getFishCompletions5;
var getZshCompletions6 = getZshCompletions5;
var getSubcommands3 = getSubcommands2;
var getUsage6 = getUsage5;
var make11 = make10;
var prompt3 = prompt2;
var provide3 = provide2;
var provideEffect2 = provideEffect;
var provideEffectDiscard2 = provideEffectDiscard;
var provideSync2 = provideSync;
var transformHandler2 = transformHandler;
var withDescription5 = withDescription4;
var withHandler2 = withHandler;
var withSubcommands3 = withSubcommands2;
var wizard7 = wizard6;
var run4 = run3;
var podmanExec = (args) => Effect_exports.async((resume) => {
  execFile(
    "podman",
    args,
    { maxBuffer: 10 * 1024 * 1024 },
    (error3, stdout, stderr) => {
      if (error3) {
        resume(
          Effect_exports.fail(
            new PodmanError({
              message: `podman ${args[0]} failed: ${stderr?.toString() || error3.message}`
            })
          )
        );
      } else {
        resume(Effect_exports.succeed(stdout.toString()));
      }
    }
  );
});
var buildImage2 = (imageName, containerfileDir, options3) => Effect_exports.gen(function* () {
  if (options3?.containerfile) {
    yield* podmanExec([
      "build",
      "-t",
      imageName,
      "-f",
      resolve(options3.containerfile),
      process.cwd()
    ]);
  } else {
    yield* podmanExec(["build", "-t", imageName, resolve(containerfileDir)]);
  }
});
var removeImage2 = (imageName) => Effect_exports.gen(function* () {
  yield* podmanExec(["rmi", imageName]);
});
var GITIGNORE = `.env
logs/
worktrees/
`;
var SETUP_ISSUE_TRACKER_DOC = "SETUP_ISSUE_TRACKER.md";
var SETUP_ISSUE_TRACKER_PATH = `.sandcastle/${SETUP_ISSUE_TRACKER_DOC}`;
var TEMPLATES = [
  {
    name: "blank",
    description: "Bare scaffold \u2014 write your own prompt and orchestration"
  },
  {
    name: "simple-loop",
    description: "Picks issues one by one and closes them"
  },
  {
    name: "sequential-reviewer",
    description: "Implements issues one by one, with a code review step after each"
  },
  {
    name: "parallel-planner",
    description: "Plans parallelizable issues, executes on separate branches, merges",
    dependencies: ["zod"]
  },
  {
    name: "parallel-planner-with-review",
    description: "Plans parallelizable issues, executes with per-branch review, merges",
    dependencies: ["zod"]
  }
];
var listTemplates = () => TEMPLATES;
var getTemplateDependencies = (templateName) => TEMPLATES.find((t) => t.name === templateName)?.dependencies ?? [];
var PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];
var LOCKFILES = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"]
];
var detectPackageManager = (repoDir) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const pkgPath = join(repoDir, "package.json");
  const pkgExists = yield* fs.exists(pkgPath).pipe(Effect_exports.orElseSucceed(() => false));
  if (pkgExists) {
    const content = yield* fs.readFileString(pkgPath).pipe(Effect_exports.orElseSucceed(() => ""));
    try {
      const pkg = JSON.parse(content);
      const field = pkg["packageManager"];
      if (typeof field === "string") {
        const name = field.split("@")[0];
        const match6 = PACKAGE_MANAGERS.find((pm) => pm === name);
        if (match6) return match6;
      }
    } catch {
    }
  }
  for (const [file4, pm] of LOCKFILES) {
    const exists = yield* fs.exists(join(repoDir, file4)).pipe(Effect_exports.orElseSucceed(() => false));
    if (exists) return pm;
  }
  return "npm";
});
var addDependencyCommand = (packageManager, pkg) => {
  switch (packageManager) {
    case "pnpm":
      return `pnpm add ${pkg}`;
    case "yarn":
      return `yarn add ${pkg}`;
    case "bun":
      return `bun add ${pkg}`;
    case "npm":
      return `npm install ${pkg}`;
  }
};
var hostHasDependency = (repoDir, pkg) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const pkgPath = join(repoDir, "package.json");
  const exists = yield* fs.exists(pkgPath).pipe(Effect_exports.orElseSucceed(() => false));
  if (!exists) return false;
  const content = yield* fs.readFileString(pkgPath).pipe(Effect_exports.orElseSucceed(() => ""));
  try {
    const parsed = JSON.parse(content);
    const depMaps = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies"
    ];
    return depMaps.some((key) => {
      const deps = parsed[key];
      return typeof deps === "object" && deps !== null && pkg in deps;
    });
  } catch {
    return false;
  }
});
var CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;
var PI_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install pi coding agent (run as root before USER agent)
RUN npm install -g @mariozechner/pi-coding-agent

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;
var CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;
var CURSOR_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Cursor Agent CLI
RUN curl https://cursor.com/install -fsS | bash

# Add Cursor CLI to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;
var OPENCODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install OpenCode CLI (run as root before USER agent)
RUN npm install -g opencode-ai@latest

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;
var COPILOT_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: sandcastle docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install GitHub Copilot CLI (run as root before USER agent)
RUN npm install -g @github/copilot

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Sandcastle bind-mounts the git worktree at \${SANDBOX_REPO_DIR}
# and overrides the working directory to \${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that \${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;
var AGENT_REGISTRY = [
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-8",
    factoryImport: "claudeCode",
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
    envExample: `# Claude Code OAuth token \u2014 get one by running \`claude setup-token\` on your host.
# Lets the agent use your Claude subscription instead of an API key.
CLAUDE_CODE_OAUTH_TOKEN=
# Or use an Anthropic API key instead \u2014 uncomment and fill in:
# ANTHROPIC_API_KEY=`,
    setupCommand: `claude "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`
  },
  {
    name: "pi",
    label: "Pi",
    defaultModel: "claude-sonnet-4-6",
    factoryImport: "pi",
    dockerfileTemplate: PI_DOCKERFILE,
    envExample: `# Anthropic API key
ANTHROPIC_API_KEY=`,
    setupCommand: `pi "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`
  },
  {
    name: "codex",
    label: "Codex",
    defaultModel: "gpt-5.4",
    factoryImport: "codex",
    dockerfileTemplate: CODEX_DOCKERFILE,
    envExample: `# OpenAI API key
OPENAI_KEY=`,
    setupCommand: `codex "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`
  },
  {
    name: "cursor",
    label: "Cursor",
    defaultModel: "composer-2",
    factoryImport: "cursor",
    dockerfileTemplate: CURSOR_DOCKERFILE,
    envExample: `# Cursor API key (recommended)
# You can also pass --api-key directly to the agent CLI.
CURSOR_API_KEY=`,
    setupCommand: `agent "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`
  },
  {
    name: "opencode",
    label: "OpenCode",
    defaultModel: "opencode/big-pickle",
    factoryImport: "opencode",
    dockerfileTemplate: OPENCODE_DOCKERFILE,
    envExample: `# OpenCode API key
OPENCODE_API_KEY=`,
    setupCommand: `opencode --prompt "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`
  },
  {
    name: "copilot",
    label: "GitHub Copilot CLI",
    defaultModel: "claude-sonnet-4.5",
    factoryImport: "copilot",
    dockerfileTemplate: COPILOT_DOCKERFILE,
    envExample: `# GitHub token with the "Copilot Requests" permission
# (a fine-grained PAT, or any token from \`gh auth login\`).
# COPILOT_GITHUB_TOKEN takes precedence over GH_TOKEN and GITHUB_TOKEN.
GITHUB_TOKEN=`,
    setupCommand: `copilot -i "$(cat ${SETUP_ISSUE_TRACKER_PATH})"`
  }
];
var listAgents = () => AGENT_REGISTRY;
var GITHUB_CLI_TOOLS = `# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*`;
var BEADS_TOOLS = `# Install system dependencies for Beads
RUN apt-get update && apt-get install -y \\
  dpkg-dev \\
  libicu72 \\
  && rm -rf /var/lib/apt/lists/* \\
  && ARCH_DIR=$(dpkg-architecture -qDEB_HOST_MULTIARCH) \\
  && for lib in /usr/lib/$ARCH_DIR/libicu*.so.72; do \\
       ln -s "$lib" "\${lib%.72}.74"; \\
     done

RUN curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

RUN corepack enable`;
var CUSTOM_LIST_TASKS_SENTINEL = `echo 'No issue tracker configured \u2014 run ${SETUP_ISSUE_TRACKER_PATH} through your coding agent.' >&2; exit 1`;
var CUSTOM_VIEW_TASK_MARKER = `<view command \u2014 see ${SETUP_ISSUE_TRACKER_PATH}>`;
var CUSTOM_CLOSE_TASK_MARKER = `<close command \u2014 see ${SETUP_ISSUE_TRACKER_PATH}>`;
var CUSTOM_TRACKER_TOOLS = `# TODO: install your issue tracker's CLI here. See ${SETUP_ISSUE_TRACKER_PATH}`;
var CUSTOM_ENV_EXAMPLE = `# TODO: add any env vars your issue tracker needs (e.g. an API token).
# See ${SETUP_ISSUE_TRACKER_PATH}`;
var ISSUE_TRACKER_REGISTRY = [
  {
    name: "github-issues",
    label: "GitHub Issues",
    templateArgs: {
      LIST_TASKS_COMMAND: `gh issue list --state open --label Sandcastle --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,
      VIEW_TASK_COMMAND: "gh issue view <ID>",
      CLOSE_TASK_COMMAND: `gh issue close <ID> --comment "Completed by Sandcastle"`,
      ISSUE_TRACKER_TOOLS: GITHUB_CLI_TOOLS
    },
    envExample: `# GitHub personal access token \u2014 the agent uses it to read and manage GitHub Issues
# Create a fine-grained token: https://github.com/settings/personal-access-tokens/new
# Required repository permissions: Issues (Read and write) and Metadata (Read)
GH_TOKEN=`
  },
  {
    name: "beads",
    label: "Beads",
    templateArgs: {
      LIST_TASKS_COMMAND: "bd ready --json",
      VIEW_TASK_COMMAND: "bd show <ID>",
      CLOSE_TASK_COMMAND: `bd close <ID> --reason="Completed by Sandcastle"`,
      ISSUE_TRACKER_TOOLS: BEADS_TOOLS
    },
    envExample: ""
  },
  {
    name: "custom",
    label: "Custom",
    templateArgs: {
      // The only real shell expression: PromptPreprocessor fails the run on a
      // non-zero exit and surfaces stderr, so this is the single enforcement
      // point that keeps the scaffold broken until the user configures it.
      LIST_TASKS_COMMAND: CUSTOM_LIST_TASKS_SENTINEL,
      // Inline text markers — replaced by the setup agent, never executed.
      VIEW_TASK_COMMAND: CUSTOM_VIEW_TASK_MARKER,
      CLOSE_TASK_COMMAND: CUSTOM_CLOSE_TASK_MARKER,
      ISSUE_TRACKER_TOOLS: CUSTOM_TRACKER_TOOLS
    },
    envExample: CUSTOM_ENV_EXAMPLE
  }
];
var listIssueTrackers = () => ISSUE_TRACKER_REGISTRY;
var getIssueTracker = (name) => ISSUE_TRACKER_REGISTRY.find((b) => b.name === name);
var getAgent = (name) => AGENT_REGISTRY.find((a) => a.name === name);
var SANDBOX_PROVIDER_REGISTRY = [
  {
    name: "docker",
    label: "Docker",
    containerfileName: "Dockerfile",
    cliNamespace: "docker"
  },
  {
    name: "podman",
    label: "Podman",
    containerfileName: "Containerfile",
    cliNamespace: "podman"
  }
];
var listSandboxProviders = () => SANDBOX_PROVIDER_REGISTRY;
var getSandboxProvider = (name) => SANDBOX_PROVIDER_REGISTRY.find((p3) => p3.name === name);
function getNextStepsLines(template, mainFilename, issueTracker, agent, packageManager) {
  if (issueTracker.name === "custom") {
    return [
      "Next steps:",
      "1. Your custom issue tracker isn't wired up yet \u2014 runs hard-fail until you configure it.",
      `2. Feed the setup prompt to ${agent.label} on your host to finish wiring it up:`,
      `   ${agent.setupCommand}`,
      `   (Runs on the host \u2014 you need the ${agent.label} CLI installed locally, since the sandbox image isn't built yet.)`,
      `3. Follow .sandcastle/${SETUP_ISSUE_TRACKER_DOC} to edit the scaffolded files in place, build the image, and verify.`
    ];
  }
  if (template === "blank") {
    const lines2 = [
      "Next steps:",
      `1. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`
    ];
    if (agent.name === "claude-code") {
      lines2.push(
        "   To use your Claude subscription instead of an API key, run `claude setup-token` on your host and paste the result into CLAUDE_CODE_OAUTH_TOKEN."
      );
    }
    lines2.push(
      "2. Read and customize .sandcastle/prompt.md to describe what you want the agent to do",
      `3. Customize .sandcastle/${mainFilename} \u2014 it uses the JS API (\`run()\`) to control how the agent runs`,
      `4. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      "5. Run `npm run sandcastle` to start the agent"
    );
    return lines2;
  } else {
    const hasReviewer = template.includes("review");
    const usesPlanSchema = getTemplateDependencies(template).includes("zod");
    let step = 1;
    const lines2 = [
      "Next steps:",
      `${step++}. Set the required env vars in .sandcastle/.env (see .sandcastle/.env.example)`
    ];
    if (agent.name === "claude-code") {
      lines2.push(
        "   To use your Claude subscription instead of an API key, run `claude setup-token` on your host and paste the result into CLAUDE_CODE_OAUTH_TOKEN."
      );
    }
    lines2.push(
      `${step++}. Add "sandcastle": "npx tsx .sandcastle/${mainFilename}" to your package.json scripts`,
      `${step++}. Templates use \`copyToWorktree: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup \u2014 the \`npm install\` in the onSandboxReady hook is a safety net for platform-specific binaries. Adjust both if you use a different package manager`
    );
    if (usesPlanSchema) {
      lines2.push(
        `${step++}. Install a schema validator for the planner's \`<plan>\` output \u2014 the template uses Zod (\`${addDependencyCommand(packageManager, "zod")}\`), but Valibot, ArkType, or any Standard Schema library works (https://standardschema.dev)`
      );
    }
    lines2.push(
      `${step++}. Read and customize the prompt files in .sandcastle/ \u2014 they shape what the agent does`
    );
    if (hasReviewer) {
      lines2.push(
        `${step++}. Customize .sandcastle/CODING_STANDARDS.md with your project's standards \u2014 the reviewer agent loads it during review`
      );
    }
    lines2.push(`${step++}. Run \`npm run sandcastle\` to start the agent`);
    return lines2;
  }
}
function getTemplatesDir() {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}
var getTemplateDir = (templateName) => Effect_exports.gen(function* () {
  const template = TEMPLATES.find((t) => t.name === templateName);
  if (!template) {
    const names = TEMPLATES.map((t) => t.name).join(", ");
    yield* Effect_exports.fail(
      new Error(`Unknown template: "${templateName}". Available: ${names}`)
    );
  }
  return join(getTemplatesDir(), templateName);
});
var COMPILED_FILE_EXTENSIONS = [
  ".js",
  ".js.map",
  ".d.ts",
  ".d.ts.map",
  ".mjs",
  ".mjs.map",
  ".d.mts",
  ".d.mts.map"
];
var copyTemplateFiles = (templateDir, destDir, mainFilename) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const files = yield* fs.readDirectory(templateDir).pipe(Effect_exports.mapError((e) => new Error(e.message)));
  yield* Effect_exports.all(
    files.filter(
      (f) => f !== "template.json" && f !== ".env.example" && !COMPILED_FILE_EXTENSIONS.some((ext) => f.endsWith(ext))
    ).map((f) => {
      const destName = f === "main.mts" ? mainFilename : f;
      return fs.copyFile(join(templateDir, f), join(destDir, destName)).pipe(Effect_exports.mapError((e) => new Error(e.message)));
    }),
    { concurrency: "unbounded" }
  );
});
var rewriteMainTs = (configDir, agent, model, sandboxProvider, mainFilename) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const mainTsPath = join(configDir, mainFilename);
  const exists = yield* fs.exists(mainTsPath).pipe(Effect_exports.mapError((e) => new Error(e.message)));
  if (!exists) return;
  let content = yield* fs.readFileString(mainTsPath).pipe(Effect_exports.mapError((e) => new Error(e.message)));
  if (mainFilename === "main.ts") {
    content = content.replace(/main\.mts/g, "main.ts");
  }
  content = content.replace(/\bclaudeCode\b/g, agent.factoryImport);
  const factoryCallRe = new RegExp(
    `${agent.factoryImport}\\(["']([^"']+)["']\\)`,
    "g"
  );
  content = content.replace(
    factoryCallRe,
    `${agent.factoryImport}("${model}")`
  );
  content = content.replace(/\bdocker\b/g, sandboxProvider.name);
  yield* fs.writeFileString(mainTsPath, content).pipe(Effect_exports.mapError((e) => new Error(e.message)));
});
var rewritePromptFiles = (configDir) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const files = yield* fs.readDirectory(configDir).pipe(Effect_exports.mapError((e) => new Error(e.message)));
  const mdFiles = files.filter((f) => f.endsWith(".md"));
  yield* Effect_exports.all(
    mdFiles.map(
      (f) => Effect_exports.gen(function* () {
        const filePath = join(configDir, f);
        const content = yield* fs.readFileString(filePath).pipe(Effect_exports.mapError((e) => new Error(e.message)));
        const updated = content.replace(/ --label Sandcastle/g, "");
        if (updated !== content) {
          yield* fs.writeFileString(filePath, updated).pipe(Effect_exports.mapError((e) => new Error(e.message)));
        }
      })
    ),
    { concurrency: "unbounded" }
  );
});
var TEXT_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".md",
  ".txt",
  ".env",
  ".example"
  // Dockerfile / Containerfile have no extension — handled by name check below
]);
var isTextFile = (filename) => {
  if (filename === "Dockerfile" || filename === "Containerfile" || filename === ".gitignore")
    return true;
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return TEXT_FILE_EXTENSIONS.has(filename.slice(dotIdx));
};
var substituteTemplateArgs = (configDir, issueTracker) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const files = yield* fs.readDirectory(configDir).pipe(Effect_exports.mapError((e) => new Error(e.message)));
  const textFiles = files.filter(isTextFile);
  yield* Effect_exports.all(
    textFiles.map(
      (f) => Effect_exports.gen(function* () {
        const filePath = join(configDir, f);
        let content = yield* fs.readFileString(filePath).pipe(Effect_exports.mapError((e) => new Error(e.message)));
        const original = content;
        for (const [key, value2] of Object.entries(
          issueTracker.templateArgs
        )) {
          content = content.replace(
            new RegExp(`\\{\\{${key}\\}\\}`, "g"),
            value2
          );
        }
        if (content !== original) {
          yield* fs.writeFileString(filePath, content).pipe(Effect_exports.mapError((e) => new Error(e.message)));
        }
      })
    ),
    { concurrency: "unbounded" }
  );
});
var buildSetupIssueTrackerDoc = (cliNamespace) => `# Set up your custom issue tracker

You are a coding agent. Finish wiring up the **custom issue tracker** for this Sandcastle project. It was scaffolded in a deliberately broken-until-configured state: until you complete the steps below, every Sandcastle run hard-fails with a pointer back to this file.

## Goal

Wire up the issue tracker so the scaffolded prompts can **list**, **view**, and **close** tasks. There is no runtime abstraction to implement \u2014 the tracker commands are baked into the scaffolded files, so you edit those files **in place**.

## 1. Interview the user

Ask the user:

- Which issue tracker do they use (e.g. Jira, Linear, a GitHub repo other than this one, an internal API)?
- How should the sandbox authenticate \u2014 a CLI that is already logged in, or an API token? If a token, what is the environment variable name?

## 2. Produce three commands

Work out, together with the user, the shell commands for:

- **list** \u2014 print all open tasks **as JSON** (match the shape the built-in trackers emit: an array of objects, each with at least an id/number, title, and body). This is what the agent reads at the start of every iteration.
- **view** \`<ID>\` \u2014 show a single task by id.
- **close** \`<ID>\` \u2014 close a single task by id.

## 3. Edit the scaffolded files in place

- **Dockerfile / Containerfile** \u2014 replace the line

  \`\`\`
  ${CUSTOM_TRACKER_TOOLS}
  \`\`\`

  with the install steps for your tracker's CLI (if it needs one).

- **Prompt files (\`.sandcastle/*.md\`)** \u2014 replace the sentinel

  \`\`\`
  ${CUSTOM_LIST_TASKS_SENTINEL}
  \`\`\`

  with your **list** command. In the prompt file the sentinel sits inside a Sandcastle **shell expression** \u2014 a leading \`!\` followed by the command in backticks \u2014 whose output is injected into the prompt before each run. Keep that \`!\` and the surrounding backticks; replace only the command between them, and **remove the \`exit 1\`** (leaving it keeps every run hard-failing). Then replace the \`${CUSTOM_VIEW_TASK_MARKER}\` and \`${CUSTOM_CLOSE_TASK_MARKER}\` markers with your **view** and **close** commands.

- **\`.env.example\`** \u2014 replace the \`# TODO\` block with the real env var(s) your tracker needs, then tell the user to set them in \`.sandcastle/.env\`.

## 4. Build the image

Once the files are wired up, build the sandbox image:

\`\`\`
sandcastle ${cliNamespace} build-image
\`\`\`

## 5. Verify

Run your **list** command inside the built image and confirm it returns the open tasks as JSON. If it errors, fix the command or the auth and rebuild.
`;
var detectMainFilename = (repoDir) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const pkgPath = join(repoDir, "package.json");
  const exists = yield* fs.exists(pkgPath).pipe(Effect_exports.orElseSucceed(() => false));
  if (!exists) return "main.mts";
  const content = yield* fs.readFileString(pkgPath).pipe(Effect_exports.orElseSucceed(() => ""));
  try {
    const pkg = JSON.parse(content);
    return pkg["type"] === "module" ? "main.ts" : "main.mts";
  } catch {
    return "main.mts";
  }
});
var scaffold = (repoDir, options3) => Effect_exports.gen(function* () {
  const {
    agent,
    model,
    templateName = "blank",
    createLabel = true,
    issueTracker = ISSUE_TRACKER_REGISTRY[0],
    // default: github-issues
    sandboxProvider = SANDBOX_PROVIDER_REGISTRY[0]
    // default: docker
  } = options3;
  const fs = yield* FileSystem_exports.FileSystem;
  const configDir = join(repoDir, ".sandcastle");
  const exists = yield* fs.exists(configDir).pipe(Effect_exports.mapError((e) => new Error(e.message)));
  if (exists) {
    yield* Effect_exports.fail(
      new Error(
        ".sandcastle/ directory already exists. Remove it first if you want to re-initialize."
      )
    );
  }
  const mainFilename = yield* detectMainFilename(repoDir);
  yield* fs.makeDirectory(configDir, { recursive: false }).pipe(Effect_exports.mapError((e) => new Error(e.message)));
  const templateDir = yield* getTemplateDir(templateName);
  const envExampleParts = [agent.envExample];
  if (issueTracker.envExample) {
    envExampleParts.push(issueTracker.envExample);
  }
  const envExampleContent = envExampleParts.join("\n") + "\n";
  yield* Effect_exports.all(
    [
      fs.writeFileString(
        join(configDir, sandboxProvider.containerfileName),
        agent.dockerfileTemplate
      ).pipe(Effect_exports.mapError((e) => new Error(e.message))),
      fs.writeFileString(join(configDir, ".gitignore"), GITIGNORE).pipe(Effect_exports.mapError((e) => new Error(e.message))),
      fs.writeFileString(join(configDir, ".env.example"), envExampleContent).pipe(Effect_exports.mapError((e) => new Error(e.message))),
      copyTemplateFiles(templateDir, configDir, mainFilename)
    ],
    { concurrency: "unbounded" }
  );
  yield* rewriteMainTs(
    configDir,
    agent,
    model,
    sandboxProvider,
    mainFilename
  );
  yield* substituteTemplateArgs(configDir, issueTracker);
  if (!createLabel) {
    yield* rewritePromptFiles(configDir);
  }
  if (issueTracker.name === "custom") {
    yield* fs.writeFileString(
      join(configDir, SETUP_ISSUE_TRACKER_DOC),
      buildSetupIssueTrackerDoc(sandboxProvider.cliNamespace)
    ).pipe(Effect_exports.mapError((e) => new Error(e.message)));
  }
  return { mainFilename };
});
var VERSION = "0.12.0" ;

// src/cli.ts
var imageNameOption = Options_exports.text("image-name").pipe(
  Options_exports.withDescription("Docker image name"),
  Options_exports.optional
);
var resolveImageName = (cliFlag, cwd) => cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd);
var defaultUidBuildArgs = () => {
  const args = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== void 0) args.AGENT_UID = String(uid);
  if (gid !== void 0) args.AGENT_GID = String(gid);
  return args;
};
var CONFIG_DIR = ".sandcastle";
var requireConfigDir = (cwd) => Effect_exports.gen(function* () {
  const fs = yield* FileSystem_exports.FileSystem;
  const exists = yield* fs.exists(join(cwd, CONFIG_DIR)).pipe(Effect_exports.catchAll(() => Effect_exports.succeed(false)));
  if (!exists) {
    yield* Effect_exports.fail(
      new ConfigDirError({
        message: "No .sandcastle/ found. Run `sandcastle init` first."
      })
    );
  }
});
var templateOption = Options_exports.text("template").pipe(
  Options_exports.withDescription(
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)"
  ),
  Options_exports.optional
);
var agentOption = Options_exports.text("agent").pipe(
  Options_exports.withDescription("Agent to use (e.g. claude-code)"),
  Options_exports.optional
);
var initModelOption = Options_exports.text("model").pipe(
  Options_exports.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6). Defaults to the agent's default model"
  ),
  Options_exports.optional
);
var sandboxOption = Options_exports.text("sandbox").pipe(
  Options_exports.withDescription("Sandbox provider to use (e.g. docker, podman)"),
  Options_exports.optional
);
var issueTrackerOption = Options_exports.text("issue-tracker").pipe(
  Options_exports.withDescription(
    "Issue tracker to use (e.g. github-issues, beads, custom)"
  ),
  Options_exports.optional
);
var createLabelOption = Options_exports.choice("create-label", [
  "true",
  "false"
]).pipe(
  Options_exports.withDescription(
    'Whether to create the "Sandcastle" GitHub label (only meaningful with --issue-tracker github-issues)'
  ),
  Options_exports.optional
);
var buildImageOption = Options_exports.choice("build-image", ["true", "false"]).pipe(
  Options_exports.withDescription(
    "Whether to build the sandbox image now (ignored when --issue-tracker custom is selected)"
  ),
  Options_exports.optional
);
var installTemplateDepsOption = Options_exports.choice("install-template-deps", [
  "true",
  "false"
]).pipe(
  Options_exports.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for the planner templates)"
  ),
  Options_exports.optional
);
var choiceToTriBool = (opt) => opt._tag === "Some" ? Option_exports.some(opt.value === "true") : Option_exports.none();
var initCommand = Command_exports.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    sandbox: sandboxOption,
    issueTracker: issueTrackerOption,
    createLabel: createLabelOption,
    buildImage: buildImageOption,
    installTemplateDeps: installTemplateDepsOption
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
    sandbox: sandboxFlag,
    issueTracker: issueTrackerFlag,
    createLabel: createLabelFlag,
    buildImage: buildImageFlag,
    installTemplateDeps: installTemplateDepsFlag
  }) => Effect_exports.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const imageName = resolveImageName(imageNameFlag, cwd);
    const templates = listTemplates();
    if (template._tag === "Some") {
      const valid = templates.find((tmpl) => tmpl.name === template.value);
      if (!valid) {
        const names = templates.map((tmpl) => tmpl.name).join(", ");
        yield* Effect_exports.fail(
          new InitError({
            message: `Unknown template "${template.value}". Available: ${names}`
          })
        );
      }
    }
    if (sandboxFlag._tag === "Some") {
      const valid = getSandboxProvider(sandboxFlag.value);
      if (!valid) {
        const names = listSandboxProviders().map((p3) => p3.name).join(", ");
        yield* Effect_exports.fail(
          new InitError({
            message: `Unknown sandbox provider "${sandboxFlag.value}". Available: ${names}`
          })
        );
      }
    }
    if (issueTrackerFlag._tag === "Some") {
      const valid = getIssueTracker(issueTrackerFlag.value);
      if (!valid) {
        const names = listIssueTrackers().map((t) => t.name).join(", ");
        yield* Effect_exports.fail(
          new InitError({
            message: `Unknown issue tracker "${issueTrackerFlag.value}". Available: ${names}`
          })
        );
      }
    }
    const createLabelChoice = choiceToTriBool(createLabelFlag);
    const buildImageChoice = choiceToTriBool(buildImageFlag);
    const installTemplateDepsChoice = choiceToTriBool(
      installTemplateDepsFlag
    );
    const isInteractive = process.stdin.isTTY === true;
    const failIfNonInteractive = (flag) => Effect_exports.fail(
      new InitError({
        message: `${flag} is required in non-interactive mode (no TTY detected).`
      })
    );
    const resolveConfirmFlag = (params) => Effect_exports.gen(function* () {
      if (params.choice._tag === "Some") return params.choice.value;
      if (!isInteractive) {
        yield* failIfNonInteractive(params.flag);
      }
      const confirmed = yield* Effect_exports.promise(
        () => clack.confirm({
          message: params.promptMessage,
          initialValue: true
        })
      );
      if (clack.isCancel(confirmed)) {
        yield* Effect_exports.fail(
          new InitError({ message: params.cancelMessage })
        );
      }
      return confirmed === true;
    });
    const agents = listAgents();
    let selectedAgent;
    if (agentFlag._tag === "Some") {
      const entry = getAgent(agentFlag.value);
      if (!entry) {
        const names = agents.map((a) => a.name).join(", ");
        yield* Effect_exports.fail(
          new InitError({
            message: `Unknown agent "${agentFlag.value}". Available: ${names}`
          })
        );
      }
      selectedAgent = entry;
    } else {
      if (!isInteractive) {
        yield* failIfNonInteractive("--agent");
      }
      const selected = yield* Effect_exports.promise(
        () => clack.select({
          message: "Select an agent:",
          initialValue: "claude-code",
          options: agents.map((a) => ({
            value: a.name,
            label: a.label,
            hint: `Default model: ${a.defaultModel}`
          }))
        })
      );
      if (clack.isCancel(selected)) {
        yield* Effect_exports.fail(
          new InitError({ message: "Agent selection cancelled." })
        );
      }
      selectedAgent = getAgent(selected);
    }
    const selectedModel = modelFlag._tag === "Some" ? modelFlag.value : selectedAgent.defaultModel;
    const sandboxProviders = listSandboxProviders();
    let selectedSandboxProvider;
    if (sandboxFlag._tag === "Some") {
      selectedSandboxProvider = getSandboxProvider(sandboxFlag.value);
    } else {
      if (!isInteractive) {
        yield* failIfNonInteractive("--sandbox");
      }
      const selected = yield* Effect_exports.promise(
        () => clack.select({
          message: "Select a sandbox provider:",
          options: sandboxProviders.map((p3) => ({
            value: p3.name,
            label: p3.label
          }))
        })
      );
      if (clack.isCancel(selected)) {
        yield* Effect_exports.fail(
          new InitError({
            message: "Sandbox provider selection cancelled."
          })
        );
      }
      selectedSandboxProvider = getSandboxProvider(selected);
    }
    const issueTrackers = listIssueTrackers();
    let selectedIssueTracker;
    if (issueTrackerFlag._tag === "Some") {
      selectedIssueTracker = getIssueTracker(issueTrackerFlag.value);
    } else {
      if (!isInteractive) {
        yield* failIfNonInteractive("--issue-tracker");
      }
      const selected = yield* Effect_exports.promise(
        () => clack.select({
          message: "Select an issue tracker:",
          initialValue: "github-issues",
          options: issueTrackers.map((b) => ({
            value: b.name,
            label: b.label
          }))
        })
      );
      if (clack.isCancel(selected)) {
        yield* Effect_exports.fail(
          new InitError({
            message: "Issue tracker selection cancelled."
          })
        );
      }
      selectedIssueTracker = getIssueTracker(selected);
    }
    let selectedTemplate;
    if (template._tag === "Some") {
      selectedTemplate = template.value;
    } else {
      if (!isInteractive) {
        yield* failIfNonInteractive("--template");
      }
      const selected = yield* Effect_exports.promise(
        () => clack.select({
          message: "Select a template:",
          initialValue: "blank",
          options: templates.map((tmpl) => ({
            value: tmpl.name,
            label: tmpl.name,
            hint: tmpl.description
          }))
        })
      );
      if (clack.isCancel(selected)) {
        yield* Effect_exports.fail(
          new InitError({ message: "Template selection cancelled." })
        );
      }
      selectedTemplate = selected;
    }
    let shouldCreateLabel = false;
    if (selectedIssueTracker.name === "github-issues") {
      shouldCreateLabel = yield* resolveConfirmFlag({
        choice: createLabelChoice,
        flag: "--create-label",
        promptMessage: 'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
        cancelMessage: "Label selection cancelled."
      });
      if (shouldCreateLabel) {
        yield* Effect_exports.try({
          try: () => execSync(
            'gh label create "Sandcastle" --description "Issues for Sandcastle to work on" --color "F9A825" 2>/dev/null',
            { cwd, stdio: "ignore" }
          ),
          catch: () => void 0
        }).pipe(Effect_exports.ignore);
      }
    }
    const scaffoldResult = yield* d.spinner(
      "Scaffolding .sandcastle/ config directory...",
      scaffold(cwd, {
        agent: selectedAgent,
        model: selectedModel,
        templateName: selectedTemplate,
        createLabel: shouldCreateLabel,
        issueTracker: selectedIssueTracker,
        sandboxProvider: selectedSandboxProvider
      }).pipe(
        Effect_exports.mapError(
          (e) => new InitError({
            message: `${e instanceof Error ? e.message : e}`
          })
        )
      )
    );
    const packageManager = yield* detectPackageManager(cwd);
    if (getTemplateDependencies(selectedTemplate).includes("zod")) {
      const alreadyInstalled = yield* hostHasDependency(cwd, "zod");
      if (!alreadyInstalled) {
        const installCmd = addDependencyCommand(packageManager, "zod");
        const shouldInstall = yield* resolveConfirmFlag({
          choice: installTemplateDepsChoice,
          flag: "--install-template-deps",
          promptMessage: `The ${selectedTemplate} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
          cancelMessage: "Install-template-deps selection cancelled."
        });
        if (shouldInstall) {
          const installed = yield* Effect_exports.sync(() => {
            try {
              execSync(installCmd, { cwd, stdio: "ignore" });
              return true;
            } catch {
              return false;
            }
          });
          yield* installed ? d.status(`Installed zod with ${packageManager}.`, "success") : d.status(
            `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
            "warn"
          );
        }
      }
    }
    const providerLabel = selectedSandboxProvider.label;
    if (selectedIssueTracker.name === "custom") {
      yield* d.status(
        "Init complete! Your custom issue tracker isn't configured yet \u2014 see the steps below before building.",
        "success"
      );
    } else {
      const shouldBuild = yield* resolveConfirmFlag({
        choice: buildImageChoice,
        flag: "--build-image",
        promptMessage: `Build the default ${providerLabel} image now?`,
        cancelMessage: "Build-image selection cancelled."
      });
      if (shouldBuild) {
        const containerfileDir = join(cwd, CONFIG_DIR);
        if (selectedSandboxProvider.name === "podman") {
          yield* d.spinner(
            `Building ${providerLabel} image '${imageName}'...`,
            buildImage2(imageName, containerfileDir)
          );
        } else {
          yield* d.spinner(
            `Building ${providerLabel} image '${imageName}'...`,
            buildImage(imageName, containerfileDir, {
              buildArgs: defaultUidBuildArgs()
            })
          );
        }
        yield* d.status(
          "Init complete! Image built successfully.",
          "success"
        );
      } else {
        yield* d.status(
          `Init complete! Run \`sandcastle ${selectedSandboxProvider.cliNamespace} build-image\` to build the ${providerLabel} image later.`,
          "success"
        );
      }
    }
    const nextSteps = getNextStepsLines(
      selectedTemplate,
      scaffoldResult.mainFilename,
      selectedIssueTracker,
      selectedAgent,
      packageManager
    );
    for (const [i, line4] of nextSteps.entries()) {
      yield* d.text(i === 0 ? line4 : styleText("dim", line4));
    }
  })
);
var dockerfileOption = Options_exports.file("dockerfile").pipe(
  Options_exports.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)"
  ),
  Options_exports.optional
);
var buildImageCommand = Command_exports.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption
  },
  ({ imageName: imageNameFlag, dockerfile }) => Effect_exports.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    yield* requireConfigDir(cwd);
    const imageName = resolveImageName(imageNameFlag, cwd);
    const dockerfileDir = join(cwd, CONFIG_DIR);
    const dockerfilePath = dockerfile._tag === "Some" ? dockerfile.value : void 0;
    yield* d.spinner(
      `Building Docker image '${imageName}'...`,
      buildImage(imageName, dockerfileDir, {
        dockerfile: dockerfilePath,
        buildArgs: defaultUidBuildArgs()
      })
    );
    yield* d.status("Build complete!", "success");
  })
);
var removeImageCommand = Command_exports.make(
  "remove-image",
  {
    imageName: imageNameOption
  },
  ({ imageName: imageNameFlag }) => Effect_exports.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const imageName = resolveImageName(imageNameFlag, cwd);
    yield* d.spinner(
      `Removing Docker image '${imageName}'...`,
      removeImage(imageName)
    );
    yield* d.status("Image removed.", "success");
  })
);
var dockerCommand = Command_exports.make(
  "docker",
  {},
  () => Effect_exports.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info"
    );
  })
).pipe(Command_exports.withSubcommands([buildImageCommand, removeImageCommand]));
var containerfileOption = Options_exports.file("containerfile").pipe(
  Options_exports.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)"
  ),
  Options_exports.optional
);
var podmanBuildImageCommand = Command_exports.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption
  },
  ({ imageName: imageNameFlag, containerfile }) => Effect_exports.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    yield* requireConfigDir(cwd);
    const imageName = resolveImageName(imageNameFlag, cwd);
    const containerfileDir = join(cwd, CONFIG_DIR);
    const containerfilePath = containerfile._tag === "Some" ? containerfile.value : void 0;
    yield* d.spinner(
      `Building Podman image '${imageName}'...`,
      buildImage2(imageName, containerfileDir, {
        containerfile: containerfilePath
      })
    );
    yield* d.status("Build complete!", "success");
  })
);
var podmanRemoveImageCommand = Command_exports.make(
  "remove-image",
  {
    imageName: imageNameOption
  },
  ({ imageName: imageNameFlag }) => Effect_exports.gen(function* () {
    const d = yield* Display;
    const cwd = process.cwd();
    const imageName = resolveImageName(imageNameFlag, cwd);
    yield* d.spinner(
      `Removing Podman image '${imageName}'...`,
      removeImage2(imageName)
    );
    yield* d.status("Image removed.", "success");
  })
);
var podmanCommand = Command_exports.make(
  "podman",
  {},
  () => Effect_exports.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info"
    );
  })
).pipe(
  Command_exports.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand])
);
var rootCommand = Command_exports.make(
  "sandcastle",
  {},
  () => Effect_exports.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  })
);
var sandcastle = rootCommand.pipe(
  Command_exports.withSubcommands([initCommand, dockerCommand, podmanCommand])
);
var cli = Command_exports.run(sandcastle, {
  name: "sandcastle",
  version: VERSION
});

// src/terminalCleanup.ts
var SHOW_CURSOR = "\x1B[?25h";
var makeTerminalCleanupHandler = (stdin, stdout) => () => {
  if (stdin.isTTY && stdin.setRawMode) {
    try {
      stdin.setRawMode(false);
    } catch {
    }
  }
  stdout.write(SHOW_CURSOR);
};
var setupTerminalCleanup = () => {
  process.on("exit", makeTerminalCleanupHandler(process.stdin, process.stdout));
};

// src/main.ts
setupTerminalCleanup();
var mainLayer = Layer_exports.merge(NodeContext_exports.layer, ClackDisplay.layer);
cli(process.argv).pipe(
  withFriendlyErrors,
  Effect_exports.provide(mainLayer),
  NodeRuntime_exports.runMain
);
//# sourceMappingURL=main.js.map
//# sourceMappingURL=main.js.map