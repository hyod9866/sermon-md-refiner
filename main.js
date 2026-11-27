'use strict';

const fs = require('fs');
const path = require('path');
const {
  Plugin,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  MarkdownView,
  requestUrl
} = require('obsidian');

const BOOKS_ALIAS = [
  ['창세기', '창'], ['출애굽기', '출'], ['레위기', '레'], ['민수기', '민'], ['신명기', '신'],
  ['여호수아', '수'], ['사사기', '삿'], ['룻기', '룻'], ['사무엘상', '삼상'], ['사무엘하', '삼하'],
  ['열왕기상', '왕상'], ['열왕기하', '왕하'], ['역대상', '대상'], ['역대하', '대하'],
  ['에스라', '스'], ['느헤미야', '느'], ['에스더', '에'], ['욥기', '욥'], ['시편', '시'],
  ['잠언', '잠'], ['전도서', '전'], ['아가', '아'], ['이사야', '사'], ['예레미야애가', '애'],
  ['예레미야', '렘'], ['에스겔', '겔'], ['다니엘', '단'], ['호세아', '호'], ['요엘', '욜'],
  ['아모스', '암'], ['오바댜', '옵'], ['요나', '욘'], ['미가', '미'], ['나훔', '나'],
  ['하박국', '합'], ['스바냐', '습'], ['학개', '학'], ['스가랴', '슥'], ['말라기', '말'],
  ['마태복음', '마'], ['마가복음', '막'], ['누가복음', '눅'], ['요한복음', '요'], ['사도행전', '행'],
  ['로마서', '롬'], ['고린도전서', '고전'], ['고린도후서', '고후'], ['갈라디아서', '갈'],
  ['에베소서', '엡'], ['빌립보서', '빌'], ['골로새서', '골'],
  ['데살로니가전서', '살전'], ['데살로니가후서', '살후'],
  ['디모데전서', '딤전'], ['디모데후서', '딤후'], ['디도서', '딛'], ['빌레몬서', '몬'],
  ['히브리서', '히'], ['야고보서', '약'], ['베드로전서', '벧전'], ['베드로후서', '벧후'],
  ['요한일서', '요일'], ['요한이서', '요이'], ['요한삼서', '요삼'],
  ['요한1서', '요일'], ['요한2서', '요이'], ['요한3서', '요삼'],
  ['유다서', '유'], ['요한계시록', '계'], ['계시록', '계']
];

const BOOK_FULL_TO_SHORT = new Map();
const ALL_BOOK_NAMES = [];
for (const [full, short] of BOOKS_ALIAS) {
  BOOK_FULL_TO_SHORT.set(full, short);
  BOOK_FULL_TO_SHORT.set(short, short);
  ALL_BOOK_NAMES.push(full, short);
}
const UNIQUE_BOOK_NAMES = Array.from(new Set(ALL_BOOK_NAMES)).sort((a, b) => b.length - a.length);
const BOOK_PATTERN = UNIQUE_BOOK_NAMES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const DEFAULT_SETTINGS = {
  geminiApiKeys: '',
  useMindmapGeminiKey: true,
  geminiModel: 'gemini-2.5-flash',
  useGeminiAi: false,
  defaultMode: 'ai_struct', // 통합 단일 모드
  docProfile: 'sermon', // 'sermon' (내 설교문 양식) | 'general' (일반 문서/원고)
  headingLevelScope: 'h1_h6', // 'h1_h6' | 'h1_h3' | 'h1_h2'
  autoNumberedStyle: 'smart', // 'smart' | 'to_bullet' | 'keep'
  mergeBrokenLines: true,
  normalizeHierarchy: true,
  spacesToTabs: true,
  normalizeBibleRefs: true,
  quoteStandaloneVerses: false,
  stripVerseBlockquotes: true,
  fixKoreanSpacing: true,
  addMissingFrontmatter: false,
  keepBackupOnOverwrite: false,
  customPromptNote: ''
};

const NAMED_ENTITIES = {
  nbsp: ' ',
  middot: '·',
  bull: '•',
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  ndash: '–',
  mdash: '—',
  hellip: '…'
};

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCodePoint(parseInt(dec, 10));
      } catch (e) {
        return _;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch (e) {
        return _;
      }
    })
    .replace(/&([a-zA-Z]+);/g, (full, name) => (NAMED_ENTITIES[name] !== undefined ? NAMED_ENTITIES[name] : full));
}

function splitFrontmatter(text) {
  const norm = String(text || '').replace(/\r\n/g, '\n');
  const m = norm.match(/^(---\n[\s\S]*?\n---(?:\n|$))/);
  if (!m) return { frontmatter: '', body: norm };
  return { frontmatter: m[1], body: norm.slice(m[1].length) };
}

function applyDocProfileFrontmatter(head, isGeneralDoc, skipModify = false) {
  const clean = String(head || '');
  if (skipModify) return clean;
  if (isGeneralDoc) {
    if (clean) {
      const m = clean.match(/^---\n([\s\S]*?)\n---(\n?)$/);
      if (m) {
        const innerLines = m[1].split('\n').filter((l) => !/^\s*vmark\s*:/i.test(l));
        innerLines.push('vmark: false');
        return `---\n${innerLines.join('\n')}\n---\n`;
      }
    }
    return '---\nvmark: false\n---\n';
  }
  if (!clean) return '';
  const m = clean.match(/^---\n([\s\S]*?)\n---(\n?)$/);
  if (m) {
    const kept = m[1].split('\n').filter((l) => !/^\s*vmark\s*:\s*false\s*$/i.test(l) && l.trim() !== '');
    if (kept.length === 0) return '';
    return `---\n${kept.join('\n')}\n---\n`;
  }
  return clean;
}

function isProtectedLine(line) {
  const t = line.trim();
  if (!t) return false;
  return /^(?:#{1,6}\s|>|```|~~~|\|.*\||---+$|\*\*\*+$|<!--|%%)/.test(t);
}

function isListLine(line) {
  return /^[ \t]*(?:[-*+]|\d+[.)]|-\.)\s+/.test(line);
}

function normalizeBibleRefsInLine(line, quoteStandalone = false, stripVerseQuotes = false) {
  if (!line) return line;
  const leading = line.match(/^[ \t]*/)[0];
  let rest = line.slice(leading.length);

  // Correct common STT/OCR proper noun typo ("아리스다교" -> "아리스다고")
  if (rest.includes('아리스다교')) {
    rest = rest.replace(/아리스다교/g, '아리스다고');
  }

  // Normalize underscore between verse range numbers anywhere after a Bible book + chap:verse
  // e.g. "행 18:1_4", "행 18:1\_4", "(빌3:13_14)" -> "행 18:1-4", "(빌3:13-14)" (without touching filenames like "44 행 18_1-17")
  const underscoreVerseRangeRe = new RegExp(
    `(${BOOK_PATTERN})(\\s*\\(?\\s*\\d{1,3}\\s*[:：]\\s*\\d{1,3})\\s*(?:\\\\?[_＿])\\s*(\\d{1,3})`,
    'g'
  );
  rest = rest.replace(underscoreVerseRangeRe, '$1$2-$3');

  // Optionally strip blockquote '>' before standalone Bible verse line (including '- > (창 1:1)' or '\t- > ...')
  if (stripVerseQuotes) {
    const bulletGt = rest.match(/^([-*+]\s+)?(>\s*)(.*)$/);
    if (bulletGt) {
      const afterGt = (bulletGt[3] || '').trim();
      const startsWithRef = new RegExp(`^[(\\[]?\\s*(?:${BOOK_PATTERN})\\s*\\(?\\s*\\d{1,3}\\s*[:：]`).test(afterGt);
      if (startsWithRef) {
        rest = `${bulletGt[1] || ''}${afterGt}`;
      } else if (!afterGt) {
        return '';
      }
    }
  }

  // "잠언(9:8)" / "삼하(16:7-10)" -> "(잠 9:8)" / "(삼하 16:7-10)"
  const splitBookParenRe = new RegExp(
    `(${BOOK_PATTERN})\\s*\\(\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*(?:[-~～_＿]|\\\\_)\\s*\\d{1,3})?)\\s*\\)`,
    'g'
  );
  rest = rest.replace(splitBookParenRe, (_, bk, ch, vs) => {
    const short = BOOK_FULL_TO_SHORT.get(bk) || bk;
    return `(${short} ${ch}:${vs.replace(/\\_/g, '-').replace(/\s+/g, '').replace(/[～~_＿]/g, '-')})`;
  });

  // "(잠언27:5)" / "(고후 5:9~10)" -> "(잠 27:5)" / "(고후 5:9-10)"
  const parenBookRe = new RegExp(
    `\\(\\s*(${BOOK_PATTERN})\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*(?:[-~～_＿]|\\\\_)\\s*\\d{1,3})?)\\s*\\)`,
    'g'
  );
  rest = rest.replace(parenBookRe, (_, bk, ch, vs) => {
    const short = BOOK_FULL_TO_SHORT.get(bk) || bk;
    return `(${short} ${ch}:${vs.replace(/\\_/g, '-').replace(/\s+/g, '').replace(/[～~_＿]/g, '-')})`;
  });

  // Ensure a space after normalized Bible ref when immediately followed by verse/word: "(눅 9:51)예수께서" -> "(눅 9:51) 예수께서"
  // Preserve direct Korean particles attached to citations: "(막 12:24)라고", "(창 1:1)에", "(롬 8:1)의"
  const tightVerseGapRe = new RegExp(
    `(\\((?:${BOOK_PATTERN})\\s+\\d{1,3}:\\d{1,3}(?:-\\d{1,3})?\\))(?!(?:이?(?:라고|라며|라는|란|고(?=\\s|$|[,.?!]))|에(?:서|는|게)?(?=\\s|$|[,.?!])|으로(?=\\s|$|[,.?!])|로(?=\\s|$|[,.?!])|을(?=\\s|$|[,.?!])|를(?=\\s|$|[,.?!])|은(?=\\s|$|[,.?!])|는(?=\\s|$|[,.?!])|이(?=\\s|$|[,.?!])|가(?=\\s|$|[,.?!])|의(?=\\s|$)|와(?=\\s|$|[,.?!])|과(?=\\s|$|[,.?!])|도(?=\\s|$|[,.?!])|만(?=\\s|$|[,.?!])|처럼|같이))([가-힣A-Za-z0-9“"'(])`,
    'g'
  );
  rest = rest.replace(tightVerseGapRe, '$1 $2');

  // "[마 16:16] 본문" or "- [마 16:16] 본문" -> "(마 16:16) 본문" (only at start/list-start followed by verse body, preserving [키워드] brackets)
  const bracketVerseRe = new RegExp(
    `^((?:[-*+]\\s+)?)\\[\\s*(${BOOK_PATTERN})\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*(?:[-~～_＿]|\\\\_)\\s*\\d{1,3})?)\\s*\\](\\s+\\S.*)$`
  );
  rest = rest.replace(bracketVerseRe, (_, bulletPrefix, bk, ch, vs, tail) => {
    const short = BOOK_FULL_TO_SHORT.get(bk) || bk;
    return `${bulletPrefix || ''}(${short} ${ch}:${vs.replace(/\\_/g, '-').replace(/\s+/g, '').replace(/[～~_＿]/g, '-')})${tail}`;
  });

  // Standalone quoted verse with trailing ref: '“말씀...”(요 18:1-11).' -> '(요 18:1-11) 말씀...'
  rest = normalizeStandaloneQuotedBibleRef(rest);

  return leading + rest;
}

function normalizeStandaloneQuotedBibleRef(restText) {
  const s = String(restText || '');
  const listM = s.match(/^((?:[-*+]\s+)?(?:>\s+)?)(.+)$/);
  if (!listM) return s;
  const prefix = listM[1] || '';
  const body = listM[2].trim();
  const m = body.match(
    new RegExp(
      `^[“"]([^\\n]{6,}?)[”"“]{1,2}\\s*\\(\\s*(${BOOK_PATTERN})\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*(?:[-~～_＿]|\\\\_)\\s*\\d{1,3})?)\\s*\\)[.?!]?$`
    )
  );
  if (m) {
    const inner = m[1].trim();
    // Ensure there isn't another closing quote followed by an earlier "(BOOK ...)" inside inner
    const earlierClosing = new RegExp(`[”"“]\\s*\\(\\s*(?:${BOOK_PATTERN})\\s*\\d{1,3}\\s*[:：]`).test(inner);
    if (!earlierClosing) {
      const short = BOOK_FULL_TO_SHORT.get(m[2]) || m[2];
      const ch = m[3];
      const vs = m[4].replace(/\\_/g, '-').replace(/\s+/g, '').replace(/[～~_＿]/g, '-');
      return `${prefix}(${short} ${ch}:${vs}) ${inner}`;
    }
  }
  return s;
}

const QUOTED_VERSE_LINE_RE = new RegExp(
  `^([ \\t]*(?:[-*+]\\s*)?)>\\s*([(\\[]?\\s*(${BOOK_PATTERN})\\s*\\(?\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*[-~～]\\s*\\d{1,3})?)\\s*[)\\]]?.*)$`
);

function extractQuotedVerseKeys(text) {
  const keys = new Set();
  for (const ln of String(text || '').split(/\r?\n/)) {
    const m = ln.match(QUOTED_VERSE_LINE_RE);
    if (m) {
      const short = BOOK_FULL_TO_SHORT.get(m[3]) || m[3];
      keys.add(`${short}:${m[4]}:${m[5].replace(/\s+/g, '').replace(/[～~]/g, '-')}`);
    }
  }
  return keys;
}

function stripAiAddedVerseBlockquotes(text, origQuotedKeys) {
  const allowed = origQuotedKeys || new Set();
  return String(text || '').split('\n').map((ln) => {
    const m = ln.match(QUOTED_VERSE_LINE_RE);
    if (!m) return ln;
    const short = BOOK_FULL_TO_SHORT.get(m[3]) || m[3];
    const key = `${short}:${m[4]}:${m[5].replace(/\s+/g, '').replace(/[～~]/g, '-')}`;
    if (allowed.has(key)) return ln;
    return `${m[1]}${m[2]}`;
  }).join('\n');
}

function getIndentWidth(leading) {
  let w = 0;
  for (const ch of leading) {
    w += (ch === '\t' ? 4 : 1);
  }
  return w;
}

function isShortSubheadingBody(body, allowPeriod = false) {
  const b = String(body || '').trim();
  if (!b || b.length > 42) return false;
  if (/%%|\*\*\*|->|=>/.test(b)) return false;
  if (/[?!]$/.test(b)) return false;
  if (/(?:다|요|죠|까|네|라|세|지)\.$/.test(b)) return allowPeriod && b.length <= 42;
  if (!allowPeriod && /\.$/.test(b)) return false;
  // Two or more comma-separated clauses usually means prose list item, not a heading
  if ((b.match(/,/g) || []).length >= 2) return false;
  return true;
}

function isCircledHeadingBody(body) {
  const b = String(body || '').trim();
  if (!b || b.length > 180) return false;
  if (/%%|\*\*\*/.test(b)) return false;
  if (/^\([가-힣]+\s*\d+:\d+/.test(b)) return false;
  return true;
}

function isNumericOutlineHeadingBody(body) {
  const b = String(body || '').replace(/\*\*|__|~~|<\/?u>/gi, '').trim();
  if (!b || b.length > 180) return false;
  if (/%%|\*\*\*|^[([]/.test(b)) return false;
  if (/^\([가-힣]+\s*\d+:\d+/.test(b)) return false;
  return true;
}

function unescapePandocMarkdown(text) {
  const lines = String(text || '').split('\n');
  let fence = false;
  return lines.map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence) return line;
    // Restore Pandoc DOCX->MD escapes outside inline code spans
    const parts = line.split(/(`[^`]*`)/g);
    for (let i = 0; i < parts.length; i += 2) {
      let seg = parts[i];
      if (i === 0) {
        seg = seg.replace(/^([ \t]*)\\([-*+])(?=\s)/, '$1$2');
        seg = seg.replace(/^([ \t]*\d{1,3})\\([.)])(?=\s|$)/, '$1$2');
      }
      seg = seg.replace(/\\([~<>'()[\].])/g, '$1');
      parts[i] = seg;
    }
    return parts.join('');
  }).join('\n');
}

function convertPandocUnderlineTags(text) {
  const input = String(text || '');
  if (!input.includes('{.underline}')) return input;
  const lines = input.split('\n');
  let fence = false;
  return lines.map((line) => {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence || !line.includes('{.underline}')) return line;
    const parts = line.split(/(`[^`]*`)/g);
    for (let i = 0; i < parts.length; i += 2) {
      let seg = parts[i];
      if (!seg.includes('{.underline}')) continue;
      let safety = 0;
      while (safety++ < 100) {
        const closeIdx = seg.indexOf(']{.underline}');
        if (closeIdx < 0) break;
        let depth = 0;
        let openIdx = -1;
        for (let j = closeIdx - 1; j >= 0; j--) {
          const ch = seg[j];
          if (ch === ']') {
            depth++;
          } else if (ch === '[') {
            if (depth === 0) {
              openIdx = j;
              // Handle Pandoc span containing an unclosed inner '[' right at start, e.g. "[[219. ...]{.underline}"
              if (j > 0 && seg[j - 1] === '[' && seg.indexOf(']]', j) === -1) {
                openIdx = j - 1;
              }
              break;
            }
            depth--;
          }
        }
        if (openIdx < 0) break;
        const inner = seg.slice(openIdx + 1, closeIdx);
        const replacement = inner.trim() ? `<u>${inner}</u>` : '';
        seg = seg.slice(0, openIdx) + replacement + seg.slice(closeIdx + ']{.underline}'.length);
      }
      parts[i] = seg;
    }
    return parts.join('');
  }).join('\n');
}

function convertHtmlParagraphAndBreakTags(text) {
  const input = String(text || '');
  if (!/<\/?(?:p|br)(?:\s|>|\/)/i.test(input)) return input;
  const lines = input.split('\n');
  let fence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fence = !fence;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    // Preserve <br> inside Markdown tables (needed for cell line breaks), strip <p>/</p> cleanly
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tbl = line
        .replace(/<\/p(?:\s[^>]*)?>\s*<p(?:\s[^>]*)?>/gi, '<br>')
        .replace(/<\/?p(?:\s[^>]*)?>/gi, '')
        .replace(/<br(?:\s+[^>]*)?\s*\/?>/gi, '<br>');
      out.push(tbl);
      continue;
    }
    const parts = line.split(/(`[^`]*`)/g);
    for (let i = 0; i < parts.length; i += 2) {
      let seg = parts[i];
      if (!/<\/?(?:p|br)(?:\s|>|\/)/i.test(seg)) continue;
      seg = seg.replace(/^[ \t]*#{1,6}[ \t]*(?:<\/?p(?:\s[^>]*)?>[ \t]*)+$/gi, '');
      seg = seg.replace(/^([ \t]*(?:[-*+]\s+|>\s+))<p(?:\s[^>]*)?>[ \t]*/gi, '$1');
      seg = seg.replace(/[ \t]*(?:<br(?:\s+[^>]*)?\s*\/?>[ \t]*){2,}/gi, '\n\n');
      seg = seg.replace(/[ \t]*<br(?:\s+[^>]*)?\s*\/?>[ \t]*/gi, '\n');
      seg = seg.replace(/[ \t]*<\/p>[ \t]*(?:<p(?:\s[^>]*)?>[ \t]*)?/gi, '\n\n');
      seg = seg.replace(/([^\n])[ \t]*<p(?:\s[^>]*)?>[ \t]*/gi, '$1\n\n');
      seg = seg.replace(/^[ \t]*<p(?:\s[^>]*)?>[ \t]*/gim, '');
      parts[i] = seg;
    }
    const joinedSeg = parts.join('');
    for (const subLine of joinedSeg.split('\n')) {
      out.push(subLine.replace(/[ \t]+$/g, ''));
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function normalizeHwpDashBullets(text) {
  const input = String(text || '');
  const lines = input.split('\n');
  let fence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fence = !fence;
      out.push(line);
      continue;
    }
    const hasGluedAlphaOnQuote = /^\s*(?:[-*+]\s*)?>/.test(line) && /\s[a-zA-Z]\.\s+[가-힣]/.test(line);
    if (fence || (!line.includes('-.') && !hasGluedAlphaOnQuote)) {
      out.push(line);
      continue;
    }
    const parts = line.split(/(`[^`]*`)/g);
    for (let i = 0; i < parts.length; i += 2) {
      let seg = parts[i];
      if (i === 0) {
        seg = seg.replace(/^([ \t]*)-\.\s*/, '$1- ');
      }
      // If an inline outline header like " B. 지혜가 충족해 짐 -. 참된 지혜는" is glued before " -. ", split it cleanly
      seg = seg.replace(/([가-힣.?!)"'”’])\s+([A-Z]\.\s+[가-힣][^\n]{1,38}?)(?=\s+-\.\s)/g, '$1\n$2');
      // Split inline Korean HWP dash bullets (" ... -. 다음 항목") into new "- " bullet lines
      seg = seg.replace(/\s+-\.\s+/g, '\n- ');
      // If a Bible verse line has an inline "a. 모세는..." / "c. 부족하고..." heading glued after the verse ends, split it onto a new line
      if (/^\s*(?:[-*+]\s*)?>/.test(seg)) {
        seg = seg.replace(/([가-힣.?!)"'”’])\s+([A-Za-z]\.\s+[가-힣][^\n]{1,42})$/g, '$1\n$2');
      }
      parts[i] = seg;
    }
    out.push(parts.join(''));
  }
  return out.join('\n');
}

function splitInlineNumberedItemsPass(lines, isGeneralDoc = false) {
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || !line.trim() || /^\s*(?:>|#{1,6}\s|\|.*\|)/.test(line) || line.trim() === '---') {
      out.push(line);
      continue;
    }

    // 1) Split inline triple-dash items ("---항목1 ---항목2") without touching standalone "---"
    if (/\s+---(?=[가-힣A-Za-z"'“‘(])/.test(line) || /^---(?=[가-힣A-Za-z"'“‘(])/.test(line.trim())) {
      const leadWs = line.match(/^[ \t]*/)[0];
      let work = line.slice(leadWs.length);
      work = work.replace(/\s+---(?=[가-힣A-Za-z"'“‘(])/g, `\n${leadWs}${isGeneralDoc ? '' : '- '}`);
      work = work.replace(/^---(?=[가-힣A-Za-z"'“‘(])/, `${leadWs}${isGeneralDoc ? '' : '- '}`);
      const dashParts = work.split('\n');
      for (const dp of dashParts) {
        if (dp.trim()) lines_pushSplitInlineNums(dp, out);
      }
      continue;
    }

    // 1b) Split inline HWP asterisk bullets ("...한다. *  1)그리스도인들은... *  다음...")
    // CommonMark never allows `*` + 2 spaces as emphasis, so inline `*\s{2,}` is strictly a pasted HWP bullet
    if (/\S\s*\*\s{2,}(?=[가-힣A-Za-z0-9“‘"'(\[])/.test(line)) {
      const leadWs = line.match(/^[ \t]*/)[0];
      const prefix = `${leadWs}${isGeneralDoc ? '' : '- '}`;
      const splitAst = line
        .replace(/([^\s*])\s*\*\s{2,}(?=[가-힣A-Za-z0-9“‘"'(\[])/g, (m, prevCh) => `${prevCh}\n${prefix}`)
        .replace(/^([ \t]*)\*\s{2,}/, `${leadWs}${isGeneralDoc ? '' : '- '}`);
      const astParts = splitAst.split('\n');
      for (let apIdx = 0; apIdx < astParts.length; apIdx++) {
        let ap = astParts[apIdx].trimEnd();
        // Clean stray unmatched HWP asterisk left at bullet boundary
        if ((ap.match(/\*/g) || []).length % 2 === 1 && /\*\s*$/.test(ap)) {
          ap = ap.replace(/\s*\*\s*$/, '').trimEnd();
        }
        if (ap.trim()) lines_pushSplitInlineNums(ap, out);
      }
      continue;
    }

    lines_pushSplitInlineNums(line, out);
  }
  return out;
}

function lines_pushSplitInlineNums(line, out) {
  let work = String(line || '');
  // Split inline bold-wrapped sequential numbered items: "... 같다.** **6. 교회를..." or "...연약함 **3. 하나님이..."
  work = work.replace(/([.?!)"'”’가-힣\]\*])\s+(\*\*\d{1,2}[.)]\s*[^*\n]{2,})/g, '$1\n$2');
  // Split inline plain sequential numbered items after sentence end if line starts with N. or has bold N.: "5. ... 같다. 6. 교회를..."
  if (/^\s*(?:\*\*)?\d{1,2}\.\s+/.test(work)) {
    const startNumM = work.match(/^\s*(?:\*\*)?(\d{1,2})\./);
    let lastNum = startNumM ? parseInt(startNumM[1], 10) : 0;
    work = work.replace(/([.?!)"'”’]\*\*|[.?!)"'”’])\s+(\d{1,2})\.\s+(?=[가-힣A-Za-z"'“‘(])/g, (full, prevEnd, numStr) => {
      const nv = parseInt(numStr, 10);
      if (nv >= lastNum + 1 && nv <= lastNum + 2 && nv <= 30) {
        lastNum = nv;
        return `${prevEnd}\n${numStr}. `;
      }
      return full;
    });
  }

  for (const part of work.split('\n')) {
    const pTrim = part.trim();
    if (!pTrim) continue;
    // Split short/topic bold numbered title from glued trailing body on the same line:
    // e.g. "**3) 그러나 하나님 앞에서 자기의 의를 드러냄** 하나님 불의하다?" or "**1. 성령을 받을 때...** “기록된바..."
    const leadWs = part.match(/^[ \t]*/)[0];
    const boldTopicGlue = pTrim.match(/^(\*\*\d{1,2}[.)]\s*[^*\n]{2,52}\*\*)(\.?)\s+([가-힣A-Za-z“"'(*].{3,})$/);
    if (boldTopicGlue) {
      const titleHead = `${boldTopicGlue[1]}${boldTopicGlue[2] || ''}`;
      out.push(`${leadWs}${titleHead}`);
      out.push(`${leadWs}${boldTopicGlue[3]}`);
    } else {
      // Normalize mixed bold-wrapped "**2. 문장...** 후속" -> "2. **문장...** 후속" so Markdown/Obsidian never renumbers partial lists
      const mixedBoldNum = pTrim.match(/^\*\*(\d{1,3})\.\s+([^*]+?)\*\*(\.?)(\s+.+)?$/);
      if (mixedBoldNum && (mixedBoldNum[3] || mixedBoldNum[4] || mixedBoldNum[2].length > 42 || /(?:다|요|죠|까|네|라)$/.test(mixedBoldNum[2].trim()))) {
        const tail = `${mixedBoldNum[3] || ''}${mixedBoldNum[4] || ''}`;
        out.push(`${leadWs}${mixedBoldNum[1]}. **${mixedBoldNum[2].trim()}**${tail}`);
      } else {
        out.push(part);
      }
    }
  }
}

function normalizeTightOutlineSpacing(rawTrimmed) {
  let t = String(rawTrimmed || '');
  if (!t) return t;
  // Restore tight Pandoc "-** " or "**-**텍스트" -> "- 텍스트"
  t = t.replace(/^\*\*-\*\*\s*/, '- ');
  // Normalize space inside markdown headings with bold/symbol e.g. "# ■제목" -> "# ■ 제목"
  t = t.replace(/^(#{1,6}\s+)([■●◆▲▶★◎◩])([^\s])/, '$1$2 $3');
  if (/^#{1,6}(?:\s|$)/.test(t) || /^#[^\s#]/.test(t)) return t;
  // Normalize missing space after symbol/number markers ("■제목" -> "■ 제목", "1.성경" -> "1. 성경", "1)파라오" -> "1) 파라오")
  t = t.replace(/^([■●◆▲▶★◎◩])([^\s])/, '$1 $2');
  t = t.replace(/^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)\.([^\s\d.])/, '$1. $2');
  t = t.replace(/^(\d{1,2})\.(?=[가-힣A-Za-z"'“‘(\[])/, '$1. ');
  t = t.replace(/^(\d{1,2})\)(?=[가-힣A-Za-z"'“‘(\[])/, '$1) ');
  t = t.replace(/^(\(\d{1,2}\))(?=[가-힣A-Za-z"'“‘\[])/, '$1 ');
  t = t.replace(/^-(?=[가-힣A-Za-z"'(①-⑳■●◆◩])/, '- ');
  return t;
}

function classifyOutlineLine(line) {
  const leading = line.match(/^[ \t]*/)[0];
  const indent = getIndentWidth(leading);
  let trimmed = line.slice(leading.length).trim();
  if (!trimmed) return { kind: 'blank', indent, leading, text: '' };

  // Normalize missing space after H2~H6 hashes ("###1) 제목" -> "### 1) 제목"), leave #hashtag untouched
  if (/^#{2,6}[^\s#]/.test(trimmed)) {
    trimmed = trimmed.replace(/^(#{2,6})([^\s#])/, '$1 $2');
  }
  trimmed = normalizeTightOutlineSpacing(trimmed);

  const mdHead = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (mdHead) {
    return { kind: 'heading', level: mdHead[1].length, indent, leading, text: trimmed };
  }
  if (/^>/.test(trimmed)) return { kind: 'quote', indent, leading, text: trimmed };
  const isOutlineDotBullet = /^[ㆍ·•]\s*(?:[①-⑳]|\d{1,2}\)|\d{1,2}\.\s|\(\d{1,2}\)|[가나다라마바사아자차카타파하]\.|[A-Za-z]\.)/.test(trimmed);
  if (/^(?:[-*+]\s+)/.test(trimmed) || isOutlineDotBullet) {
    const bulletBody = normalizeTightOutlineSpacing(trimmed.replace(/^(?:[-*+]\s+|[ㆍ·•]\s*)/, ''));
    // Unwrap "- 1) ..." / "ㆍ1) ...", "- (1) ..." / "ㆍ(1) ...", "- ① ..." / "ㆍ① ..."
    const wrappedHalf = bulletBody.match(/^(\d{1,2}\))\s+(.+)$/);
    if (wrappedHalf) {
      return {
        kind: 'outline_sub',
        rank: 3,
        headingRank: 3,
        canBeHeading: indent === 0 ? isNumericOutlineHeadingBody(wrappedHalf[2]) : isShortSubheadingBody(wrappedHalf[2], true),
        indent,
        leading,
        marker: wrappedHalf[1],
        body: wrappedHalf[2],
        text: `${wrappedHalf[1]} ${wrappedHalf[2]}`
      };
    }
    const wrappedFull = bulletBody.match(/^(\(\d{1,2}\))\s+(.+)$/);
    if (wrappedFull) {
      return {
        kind: 'outline_sub',
        rank: 3.5,
        headingRank: 4,
        canBeHeading: isShortSubheadingBody(wrappedFull[2], true),
        indent,
        leading,
        marker: wrappedFull[1],
        body: wrappedFull[2],
        text: `${wrappedFull[1]} ${wrappedFull[2]}`
      };
    }
    const wrappedCircled = bulletBody.match(/^([①-⑳])\s*(.+)$/);
    if (wrappedCircled) {
      return {
        kind: 'outline_sub',
        rank: 2,
        headingRank: 4.5,
        canBeHeading: isCircledHeadingBody(wrappedCircled[2]),
        indent,
        leading,
        marker: wrappedCircled[1],
        body: wrappedCircled[2],
        text: `${wrappedCircled[1]} ${wrappedCircled[2]}`
      };
    }
    return { kind: 'bullet', indent, leading, marker: '-', body: bulletBody, text: `- ${bulletBody}` };
  }

  // Roman numerals I. II. III. / Ⅰ. Ⅱ. ... -> Rank 1
  const roman = trimmed.match(/^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|[IVX]{1,4})\.\s+(.+)$/);
  if (roman && roman[2].length <= 60) {
    return { kind: 'heading_roman', rank: 1, indent, title: `${roman[1]}. ${roman[2]}`, text: trimmed };
  }

  // Box/square/symbol headings at column 0: "■ 회개의 정의" / "● 도입" -> Rank 1
  const symHead = trimmed.match(/^([■●◆▲▶★◎◩])\s+(.+)$/);
  if (symHead && indent === 0 && symHead[2].length <= 55) {
    return { kind: 'heading_sym', rank: 1, indent, sym: symHead[1], title: symHead[2], text: trimmed };
  }

  // Bold-wrapped numbered lines: "**1. 잘못된 지식**", "**1) 욥의 지혜**" -> evaluate inner text identically
  const boldNumLine = trimmed.match(/^\*\*(\d{1,4})\.\s*(.+?)\*\*(\.?)$/);
  if (boldNumLine) {
    const numVal = parseInt(boldNumLine[1], 10);
    const bodyText = boldNumLine[2].trim();
    const bodyOut = `**${bodyText}**${boldNumLine[3] || ''}`;
    if (indent === 0 && numVal >= 1 && numVal <= 30 && isNumericOutlineHeadingBody(bodyText)) {
      return { kind: 'heading_num_candidate', rank: 2, indent, leading, num: boldNumLine[1], numVal, title: bodyOut, body: bodyOut, text: `${boldNumLine[1]}. ${bodyOut}` };
    }
    return { kind: 'ordered_list', indent, leading, num: boldNumLine[1], numVal, body: bodyOut, text: trimmed };
  }

  const boldHalfParen = trimmed.match(/^\*\*(\d{1,2}\))\s*(.+?)\*\*(\.?)$/);
  if (boldHalfParen) {
    const bodyText = `${boldHalfParen[2].trim()}${boldHalfParen[3] || ''}`;
    return {
      kind: 'outline_sub',
      rank: 3,
      headingRank: 3,
      canBeHeading: indent === 0 ? isNumericOutlineHeadingBody(bodyText) : isShortSubheadingBody(bodyText, true),
      indent,
      leading,
      marker: boldHalfParen[1],
      body: bodyText,
      text: `${boldHalfParen[1]} ${bodyText}`
    };
  }

  // Numbered line: "1. 본문" (col 0 heading candidate) vs ordered list item ("\t1. ..." or >30 year)
  const numLine = trimmed.match(/^(\d{1,4})\.\s+(.+)$/);
  if (numLine) {
    const numVal = parseInt(numLine[1], 10);
    const bodyText = numLine[2];
    if (indent === 0 && numVal >= 1 && numVal <= 30 && isNumericOutlineHeadingBody(bodyText)) {
      return { kind: 'heading_num_candidate', rank: 2, indent, leading, num: numLine[1], numVal, title: bodyText, body: bodyText, text: trimmed };
    }
    return { kind: 'ordered_list', indent, leading, num: numLine[1], numVal, body: bodyText, text: trimmed };
  }

  // Half-paren numbers "1) 제목" -> Rank 3 heading candidate
  const halfParenNum = trimmed.match(/^(\d{1,2}\))\s+(.+)$/);
  if (halfParenNum) {
    return {
      kind: 'outline_sub',
      rank: 3,
      headingRank: 3,
      canBeHeading: indent === 0 ? isNumericOutlineHeadingBody(halfParenNum[2]) : isShortSubheadingBody(halfParenNum[2], true),
      indent,
      leading,
      marker: halfParenNum[1],
      body: halfParenNum[2],
      text: trimmed
    };
  }

  // Full-paren numbers "(1) 제목" -> Rank 4 heading candidate if short title, else list item
  const fullParenNum = trimmed.match(/^(\(\d{1,2}\))\s+(.+)$/);
  if (fullParenNum) {
    return {
      kind: 'outline_sub',
      rank: 3.5,
      headingRank: 4,
      canBeHeading: isShortSubheadingBody(fullParenNum[2], true),
      indent,
      marker: fullParenNum[1],
      body: fullParenNum[2],
      text: trimmed
    };
  }

  // Circled numerals ①..⑳
  const circled = trimmed.match(/^([①-⑳])\s*(.+)$/);
  if (circled) {
    return {
      kind: 'outline_sub',
      rank: 2,
      headingRank: 4.5,
      canBeHeading: isCircledHeadingBody(circled[2]),
      indent,
      marker: circled[1],
      body: circled[2],
      text: trimmed
    };
  }

  // Korean syllable outline: 가. 나. 다. ... 하.
  const korAlpha = trimmed.match(/^([가나다라마바사아자차카타파하]\.)\s*(.+)$/);
  if (korAlpha) {
    return {
      kind: 'outline_sub',
      rank: 3,
      headingRank: 5,
      canBeHeading: isShortSubheadingBody(korAlpha[2], false),
      indent,
      marker: korAlpha[1],
      body: korAlpha[2],
      text: trimmed
    };
  }

  // Uppercase Latin letter outline: A. B. C. ... (avoid initials like "C. S. 루이스")
  const capAlpha = trimmed.match(/^([A-Z]\.)\s+(.+)$/);
  if (capAlpha && !/^[A-Z]\./.test(capAlpha[2]) && capAlpha[2].length <= 45) {
    return {
      kind: 'outline_sub',
      rank: 4.8,
      headingRank: 4.5,
      canBeHeading: isShortSubheadingBody(capAlpha[2], false),
      indent,
      leading,
      marker: capAlpha[1],
      body: capAlpha[2],
      text: trimmed
    };
  }

  // Lowercase Latin letter outline: a. b. c. ...
  const lowAlpha = trimmed.match(/^([a-z]\.)\s+(.+)$/);
  if (lowAlpha && !/^[a-z]\./.test(lowAlpha[2]) && lowAlpha[2].length <= 45) {
    return {
      kind: 'outline_sub',
      rank: 5.8,
      headingRank: 5.5,
      canBeHeading: isShortSubheadingBody(lowAlpha[2], false),
      indent,
      leading,
      marker: lowAlpha[1],
      body: lowAlpha[2],
      text: trimmed
    };
  }

  // Korean paren "(가)", Roman letter paren "a)", "(a)", fullwidth "Ａ."
  const subAlpha = trimmed.match(/^(\([가-하]\)|[a-zA-Z]\)|\([a-zA-Z]\)|[Ａ-Ｚ]\.)\s*(.+)$/);
  if (subAlpha) {
    return {
      kind: 'outline_sub',
      rank: 4,
      headingRank: 6,
      canBeHeading: isShortSubheadingBody(subAlpha[2], false),
      indent,
      marker: subAlpha[1],
      body: subAlpha[2],
      text: trimmed
    };
  }

  // Angle-bracket short standalone subheading like "<저번주 복습>"
  const angleHead = trimmed.match(/^(<[^<>\n]{2,28}>)$/);
  if (angleHead && indent === 0) {
    return {
      kind: 'heading_angle',
      headingRank: 5.5,
      indent,
      title: angleHead[1],
      text: trimmed
    };
  }

  // HWP bullet symbols: • ◦ ▪ □ ○ ▶ ◈ (never peel repeated placeholders like ○○○)
  const hwpBullet = trimmed.match(/^([•◦▪□○▶◈])\s*(?![•◦▪□○▶◈])(.+)$/);
  if (hwpBullet) {
    return { kind: 'outline_sub', rank: 2, canBeHeading: false, indent, marker: '', body: hwpBullet[2], text: trimmed };
  }

  return { kind: 'plain', indent, leading, text: trimmed };
}

function hasUnclosedInlineBracket(str) {
  const s = String(str || '').replace(/\[\[[^\]]*\]\]/g, '');
  let depth = 0;
  for (const ch of s) {
    if (ch === '[') depth++;
    else if (ch === ']' && depth > 0) depth--;
  }
  return depth > 0;
}

function hasActiveVerseRangeTail(prevTrimmed, nextTrimmed) {
  const nTrim = String(nextTrimmed || '').trim();
  if (!nTrim || /^\s*(?:[-*+]\s*)?>/.test(nTrim) || isListLine(nextTrimmed)) return false;
  if (BIBLE_REF_HEADER_RE.test(nTrim.replace(/^[-*+>\s]+/, ''))) return false;
  const cleanP = prevTrimmed.replace(/^(?:[-*+]\s*)?>\s*/, '');
  const rangeM = cleanP.match(new RegExp(`^\\(?(?:${BOOK_PATTERN})\\s*\\d{1,3}:(\\d{1,3})\\s*[-~]\\s*(\\d{1,3})\\)?\\s*(.*)$`));
  if (!rangeM) return false;
  const startVerse = parseInt(rangeM[1], 10);
  const endVerse = parseInt(rangeM[2], 10);
  const bodyAfterHeader = rangeM[3] || '';
  const hasInlineVerseMarkers =
    new RegExp(`(?:^|\\s)(?:\\[${startVerse}\\]|\\(${startVerse}\\)|${startVerse}(?=[가-힣]|\\s))`).test(bodyAfterHeader) ||
    /^(?:\[\d{1,3}\]|\(\d{1,3}\))/.test(nTrim);
  if (!hasInlineVerseMarkers) return false;
  // Check whether endVerse has already appeared in prevTrimmed (supporting [17], (17), or 17한글/17 )
  const endVerseRe = new RegExp(`\\[${endVerse}\\]|\\(${endVerse}\\)|\\b${endVerse}(?=[가-힣]|\\s)`);
  if (!endVerseRe.test(cleanP)) return true;
  const parts = cleanP.split(endVerseRe);
  const afterEndV = parts[parts.length - 1] || '';
  const afterClean = afterEndV.trim().replace(/(?:\]\{\.underline\}|\]|\})+$/g, '').trim();
  return !/[.?!。？！"”’]$|(?:니라|리라|도다|노라|지어다|나이다|소서|아멘|다|요|라)$/.test(afterClean);
}

const _bibleVerseCache = new Map();

function normBibleHangul(str) {
  return String(str || '')
    .replace(/<\/?u>/gi, '')
    .replace(/\*\*|__|~~|\{\.underline\}/g, '')
    .replace(/^\s*>\s*/, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\(\d{1,3}\)|\[\d{1,3}\]/g, '')
    .replace(/[^가-힣a-zA-Z0-9]/g, '')
    .toLowerCase();
}

function getBibleVerseLookup(vaultBasePath) {
  const roots = [];
  if (vaultBasePath) roots.push(vaultBasePath);
  if (typeof __dirname === 'string') {
    roots.push(path.resolve(__dirname, '..', '..', '..'));
  }
  const cacheKey = roots[0] || '__none__';
  if (_bibleVerseCache.has(cacheKey)) return _bibleVerseCache.get(cacheKey);

  const maps = [];
  for (const root of roots) {
    if (!root) continue;
    const bibDir = path.join(root, '_bibles');
    try {
      if (!fs.existsSync(bibDir)) continue;
      for (const fname of ['개역한글.btx', '개역개정4판.btx']) {
        const fp = path.join(bibDir, fname);
        if (!fs.existsSync(fp)) continue;
        const map = new Map();
        const raw = fs.readFileSync(fp, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
          const m = line.match(/^\s*\d{2}([가-힣]+)\s+(\d{1,3}):(\d{1,3})\s+(.+)$/);
          if (m) {
            map.set(`${m[1]}:${m[2]}:${m[3]}`, m[4].trim());
          }
        }
        if (map.size > 0) maps.push(map);
      }
      if (maps.length > 0) break;
    } catch (e) { /* fallback cleanly without local bible */ }
  }
  _bibleVerseCache.set(cacheKey, maps);
  return maps;
}

const BIBLE_REF_HEADER_RE = new RegExp(
  `^\\s*(?:[-*+]\\s*)?(?:>\\s*)?(?:\\*\\*|__)?[\\[(]?\\s*(${BOOK_PATTERN})\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3})(?:\\s*[-~]\\s*(\\d{1,3}))?[\\])]?(?:\\*\\*|__)?\\s*(.*)$`
);

function doesLineContinueBiblePassage(prevLine, curLine, bibleMaps) {
  if (!bibleMaps || bibleMaps.length === 0 || !prevLine || !curLine) return null;
  const hm = String(prevLine).match(BIBLE_REF_HEADER_RE);
  if (!hm) return null;

  const curTrim = String(curLine).trim();
  if (!curTrim) return null;
  if (BIBLE_REF_HEADER_RE.test(curTrim)) return null;
  // Never absorb real headings/major symbols/outline markers ("### 1)", "## ▶", "1) ...")
  if (/^(?:#{1,2}\s|[■●◆▲▶★◎◩]|[①-⑳]|\d+[.)]\s|[가-하]\.\s)/.test(curTrim)) return null;
  if (/^#{3,6}\s+(?!\(\d{1,3}\))/.test(curTrim)) return null;

  const abbr = BOOK_FULL_TO_SHORT.get(hm[1]) || hm[1];
  const chap = parseInt(hm[2], 10);
  const v1 = parseInt(hm[3], 10);
  const v2 = hm[4] ? Math.min(v1 + 30, parseInt(hm[4], 10)) : v1;
  const prevBody = (hm[5] || '').replace(/^(?:KOR|NKJV|KJV|NIV|ESV|개역한글|개역개정|새번역|공동번역|현대인의성경)\b\s*/i, '');
  const prevNorm = normBibleHangul(prevBody);

  // Strip accidental "- ", "### (?=(12))" on continuation fragment
  const cleanedCur = curTrim
    .replace(/^#{3,6}\s+(?=\(\d{1,3}\))/, '')
    .replace(/^[-*+]\s+/, '');
  const curNorm = normBibleHangul(cleanedCur);
  if (curNorm.length < 3) return null;

  for (const bMap of bibleMaps) {
    const parts = [];
    for (let v = v1; v <= v2; v++) {
      const txt = bMap.get(`${abbr}:${chap}:${v}`);
      if (txt) parts.push(txt);
    }
    if (parts.length === 0) continue;
    const realNorm = normBibleHangul(parts.join(' '));
    if (!realNorm) continue;

    // Locate where prev ends in realNorm
    let matchEnd = 0;
    if (prevNorm.length >= 6) {
      const tailLen = Math.min(18, prevNorm.length);
      const tail = prevNorm.slice(-tailLen);
      const foundIdx = realNorm.indexOf(tail);
      if (foundIdx >= 0) {
        matchEnd = foundIdx + tailLen;
      } else {
        const midLen = Math.min(12, prevNorm.length);
        const midIdx = realNorm.indexOf(prevNorm.slice(0, midLen));
        if (midIdx >= 0) matchEnd = midIdx + prevNorm.length;
      }
    }
    const remReal = realNorm.slice(matchEnd);
    if (!remReal) continue;

    const probe = curNorm.slice(0, Math.min(14, curNorm.length));
    const exactStart = remReal.startsWith(probe);
    const shortTailMatch = curNorm.length <= 12 && remReal === curNorm;
    const nearStartIdx = curNorm.length >= 8 ? remReal.indexOf(probe) : -1;
    const closeMatch = nearStartIdx >= 0 && nearStartIdx <= 6;
    if (exactStart || shortTailMatch || closeMatch) {
      return { mergedCur: cleanedCur };
    }
  }
  return null;
}

function getRealBibleTexts(abbr, chap, v1, v2, bibleMaps) {
  const out = [];
  if (!bibleMaps || bibleMaps.length === 0) return out;
  for (const bMap of bibleMaps) {
    const parts = [];
    for (let v = v1; v <= v2; v++) {
      const txt = bMap.get(`${abbr}:${chap}:${v}`);
      if (txt) parts.push(txt);
    }
    if (parts.length > 0) {
      out.push({
        bMap,
        realNorm: normBibleHangul(parts.join(' ')),
        lastNorm: normBibleHangul(parts[parts.length - 1] || ''),
        nextNorm: normBibleHangul(bMap.get(`${abbr}:${chap}:${v2 + 1}`) || '')
      });
    }
  }
  return out;
}

function doesTextStartBibleVerse(bodyText, abbr, chap, v1, v2, bibleMaps) {
  const entries = getRealBibleTexts(abbr, chap, v1, v2, bibleMaps);
  if (entries.length === 0) return false;
  const bNorm = normBibleHangul(bodyText);
  if (bNorm.length < 6) return false;
  const probe = bNorm.slice(0, Math.min(10, bNorm.length));
  return entries.some((e) => {
    const idx = e.realNorm.indexOf(probe);
    return idx >= 0 && idx <= 20;
  });
}

function isBiblePassageCompleteAgainstLookup(line, curLine, bibleMaps) {
  if (!bibleMaps || bibleMaps.length === 0 || !line) return false;
  const hm = String(line).match(BIBLE_REF_HEADER_RE);
  if (!hm) return false;
  const abbr = BOOK_FULL_TO_SHORT.get(hm[1]) || hm[1];
  const chap = parseInt(hm[2], 10);
  const v1 = parseInt(hm[3], 10);
  const v2 = hm[4] ? Math.min(v1 + 30, parseInt(hm[4], 10)) : v1;
  const prevNorm = normBibleHangul(hm[5] || '');
  if (prevNorm.length < 6) return false;
  const entries = getRealBibleTexts(abbr, chap, v1, v2, bibleMaps);
  if (entries.length === 0) return false;
  const curNorm = normBibleHangul(curLine || '');
  return entries.some((e) => {
    const tailLen = Math.min(8, e.lastNorm.length);
    if (tailLen < 5) return false;
    const tail = e.lastNorm.slice(-tailLen);
    if (!prevNorm.endsWith(tail) && !prevNorm.slice(-14).includes(tail)) return false;
    // Make sure curLine isn't closing bold/underline/punctuation from the same verse
    if (curNorm.length < 4) return false;
    return true;
  });
}

function findBibleVerseSplitTailIndex(restText, abbr, chap, v1, v2, bibleMaps) {
  const rest = String(restText || '');
  if (!rest || rest.length < 16 || !bibleMaps || bibleMaps.length === 0) return -1;
  const entries = getRealBibleTexts(abbr, chap, v1, v2, bibleMaps);
  if (entries.length === 0) return -1;

  // Candidate boundaries: sentence punctuation + space, OR classical Korean verse ending + space
  const boundaryRe = /(?:[.?!。？！]+["'”’)*\]]*(?:\*\*|<\/u>)?|(?:니라|리라|도다|노라|지어다|나이다|소서|아멘|하더라|이라|더라|였더라|았더라|었더라|시더라|리요|느뇨|니이까|리이까|것이요)(?:\*\*|<\/u>)?)\s+(?=\S)/g;
  let bestSplit = -1;
  let m;
  while ((m = boundaryRe.exec(rest)) !== null) {
    const boundaryEnd = m.index + m[0].length;
    const beforePart = rest.slice(0, m.index + m[0].trimEnd().length);
    const afterPart = rest.slice(boundaryEnd).trim();
    if (afterPart.length < 4) continue;
    if (/^\((?:kjv|niv|esv|nkjv|개역|표준|새번역|공동|현대)/i.test(afterPart)) continue;
    const beforeNorm = normBibleHangul(beforePart);
    const afterNorm = normBibleHangul(afterPart);
    if (beforeNorm.length < 6 || afterNorm.length < 4) continue;

    for (const e of entries) {
      const tailLen = Math.min(9, e.lastNorm.length);
      if (tailLen < 5) continue;
      const tail = e.lastNorm.slice(-tailLen);
      const endsAtTail = beforeNorm.endsWith(tail) || beforeNorm.slice(-14).includes(tail);
      if (!endsAtTail) continue;
      const afterProbe = afterNorm.slice(0, Math.min(8, afterNorm.length));
      if (e.realNorm.includes(afterProbe) || (e.nextNorm && e.nextNorm.startsWith(afterProbe))) continue;
      bestSplit = boundaryEnd;
    }
  }
  return bestSplit;
}

function findOpeningQuoteBefore(str, minIdx, closeIdx, closerChars) {
  // Curly closing '”': pair matching '“' right-to-left tracking depth
  if (closerChars.includes('”')) {
    let depth = 1;
    let fallbackAscii = -1;
    for (let k = closeIdx - 1; k >= minIdx; k--) {
      const ch = str[k];
      if (ch === '”') depth++;
      else if (ch === '“') {
        depth--;
        if (depth === 0) return k;
      } else if (ch === '"' && fallbackAscii === -1) {
        fallbackAscii = k;
      }
    }
    if (fallbackAscii !== -1) return fallbackAscii;
  }
  // ASCII '"' or HWP swapped '“' closer: track ASCII pairs left-to-right inside [minIdx..closeIdx)
  let openQuote = -1;
  let inAscii = false;
  for (let k = minIdx; k < closeIdx; k++) {
    const ch = str[k];
    if (ch === '"') {
      if (!inAscii) {
        inAscii = true;
        openQuote = k;
      } else {
        inAscii = false;
      }
    } else if (ch === '“' && !inAscii) {
      openQuote = k;
    }
  }
  if (inAscii && openQuote !== -1) return openQuote;
  if (openQuote !== -1 && closeIdx - openQuote >= 6) return openQuote;
  return -1;
}

function splitAndNormalizeBiblePassagesPass(lines, opts = {}, bibleMapsInput = null) {
  if (opts.normalizeBibleRefs === false) return lines;
  const bibleMaps = Array.isArray(bibleMapsInput) ? bibleMapsInput : getBibleVerseLookup(opts.vaultBasePath || '');
  const isGeneralDoc = opts.docProfile === 'general';
  const trailingQuoteRefRe = new RegExp(
    `([”"“]{1,2})\\s*[(\\[]\\s*(${BOOK_PATTERN})\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*(?:[-~～_＿]|\\\\_)\\s*\\d{1,3})?)\\s*[)\\]]([.?!]?)`,
    'g'
  );
  const embeddedFrontRefRe = new RegExp(
    `((?:\\*\\*|__)?[\\[(]\\s*(${BOOK_PATTERN})\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*(?:[-~～_＿]|\\\\_)\\s*\\d{1,3})?)\\s*[\\])](?:\\*\\*|__)?)\\s+(.+)$`
  );
  const leadVerseLineRe = new RegExp(
    `^([ \\t]*(?:[-*+]\\s+)?(?:>\\s+)?)(?:\\*\\*|__)?[\\[(]\\s*(${BOOK_PATTERN})\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*(?:[-~～_＿]|\\\\_)\\s*\\d{1,3})?)\\s*[\\])](?:\\*\\*|__)?\\s+(.+)$`
  );
  const inlineGrammarTailRe = /^(?:이?(?:라고|고(?:\s|$|[,.?!])|라며|이라는|라는|란|하[고며여셨습니]|말씀하)|(?:을|를|은|는|이|가|에|에서|으로|로|와|과|의|도|만|처럼|같이)(?=\s|$|[,.?!]))/;
  const inlineSpaceGrammarTailRe = /^\s*(?:라고|이라고|하[셨고며습]|말씀하[셨고])/;

  const out = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      out.push(rawLine);
      continue;
    }
    const trim = rawLine.trim();
    if (
      inFence ||
      !trim ||
      /^(?:#{1,6}\s|\|.*\||---+$|\*\*\*+$|<!--|%%)/.test(trim) ||
      /^(?:강사|장소|날짜|일시|본문|제목|주제|시간|비고|참고)\s*[:：]/.test(trim)
    ) {
      out.push(rawLine);
      continue;
    }

    const leadMatch = rawLine.match(/^([ \t]*(?:(?:-\s+)?(?:>\s+)?|\*\s+))(.*)$/);
    const leadFull = leadMatch ? leadMatch[1] : '';
    const leadWs = rawLine.match(/^[ \t]*/)[0];
    const hasTabBullet = /^\t+-\s+$/.test(leadFull) || (!isGeneralDoc && /^-\s+$/.test(leadFull));
    const contLead = hasTabBullet ? `${leadWs}- ` : leadWs;
    const work = leadMatch ? leadMatch[2] : rawLine;

    // Step 1: Convert & split "~~~"(BOOK chap:verse) segments left-to-right
    const stage1Segs = [];
    trailingQuoteRefRe.lastIndex = 0;
    let searchMin = 0;
    let inlineAcc = '';
    let firstSeg = true;
    let rm;

    const pushSeg = (segText) => {
      const cleaned = segText.trim();
      if (!cleaned) return;
      const pfx = firstSeg ? leadFull : contLead;
      stage1Segs.push(`${pfx}${cleaned}`);
      firstSeg = false;
    };

    while ((rm = trailingQuoteRefRe.exec(work)) !== null) {
      const closer = rm[1];
      const closeStart = rm.index;
      const matchEnd = rm.index + rm[0].length;
      const bk = rm[2];
      const ch = rm[3];
      const vs = rm[4].replace(/\\_/g, '-').replace(/\s+/g, '').replace(/[～~_＿]/g, '-');
      const short = BOOK_FULL_TO_SHORT.get(bk) || bk;
      const trailPunct = rm[5] || '';
      const after = work.slice(matchEnd);

      const openIdx = findOpeningQuoteBefore(work, searchMin, closeStart, closer);
      let effOpenIdx = openIdx;
      let missingOpener = false;
      if (effOpenIdx === -1 && searchMin === 0 && !inlineAcc && !after.trim()) {
        // Missing opening quote on a full standalone verse line ("...있느니라”(욥12:10).")
        const cand = work.slice(0, closeStart).trim();
        const plainCand = cand.replace(/\*\*|__|~~|<\/?u>/gi, '').trim();
        const looksLikeVerseEnd = /(?:니라|리라|도다|노라|지어다|나이다|소서|으매|로다|더라|아멘|요|다)[.?!]?$/.test(plainCand);
        if (cand.length >= 8 && (doesTextStartBibleVerse(cand, short, parseInt(ch, 10), parseInt(vs, 10), parseInt(vs, 10), bibleMaps) || looksLikeVerseEnd)) {
          effOpenIdx = 0;
          missingOpener = true;
        }
      }

      if (effOpenIdx === -1) continue;

      const quoteInner = (missingOpener ? work.slice(0, closeStart) : work.slice(effOpenIdx + 1, closeStart)).trim();
      if (quoteInner.length < 4) continue;

      // Guard against inline grammatical embedding: `예수님은 “...”(막12:24)라고 하셨다.`
      const isGrammaticalInline =
        (!trailPunct && inlineGrammarTailRe.test(after)) ||
        inlineSpaceGrammarTailRe.test(after) ||
        (quoteInner.replace(/\*\*|__|~~|<\/?u>/gi, '').trim().length < 6 && /[은는이가을를의로에]$/.test(work.slice(searchMin, effOpenIdx).trim()));

      if (isGrammaticalInline) {
        inlineAcc += `${work.slice(searchMin, closeStart)}${closer}(${short} ${ch}:${vs})${trailPunct}`;
        searchMin = matchEnd;
        continue;
      }

      const prefixChunk = `${inlineAcc}${work.slice(searchMin, effOpenIdx)}`.trim();
      inlineAcc = '';
      if (prefixChunk) {
        pushSeg(prefixChunk);
      }
      pushSeg(`(${short} ${ch}:${vs}) ${quoteInner}`);
      searchMin = matchEnd;
    }

    const remTail = `${inlineAcc}${work.slice(searchMin)}`.trim();
    if (remTail) {
      // Handle missing closing quote on a standalone line: `“내가 알기에는 ... 초급하구나(욥19:25-27).`
      const missingCloserM = remTail.match(
        new RegExp(
          `^[“"]([^”"\\n]{10,}?)\\(\\s*(${BOOK_PATTERN})\\s*(\\d{1,3})\\s*[:：]\\s*(\\d{1,3}(?:\\s*[-~～]\\s*\\d{1,3})?)\\s*\\)[.?!]?$`
        )
      );
      if (missingCloserM) {
        const short = BOOK_FULL_TO_SHORT.get(missingCloserM[2]) || missingCloserM[2];
        const ch = missingCloserM[3];
        const vs = missingCloserM[4].replace(/\s+/g, '').replace(/[～~]/g, '-');
        pushSeg(`(${short} ${ch}:${vs}) ${missingCloserM[1].trim()}`);
      } else {
        pushSeg(remTail);
      }
    }

    // Step 2: Split glued explanation BEFORE or AFTER `(BOOK chap:verse) verseText` on each resulting segment
    const stage2Segs = [];
    for (const seg of stage1Segs) {
      let curSeg = seg;
      let guardCount = 0;
      while (curSeg && guardCount++ < 8) {
        const curLeadM = curSeg.match(/^([ \t]*(?:(?:-\s+)?(?:>\s+)?|\*\s+))(.*)$/);
        const curLeadFull = curLeadM ? curLeadM[1] : '';
        const curBody = curLeadM ? curLeadM[2] : curSeg;

        // 2a) Check if there is explanatory text BEFORE an embedded `(BOOK chap:verse) verseText`
        let splitBeforeIdx = -1;
        let scanFrom = 1;
        while (scanFrom < curBody.length) {
          const sliceStr = curBody.slice(scanFrom);
          const em = sliceStr.match(embeddedFrontRefRe);
          if (!em) break;
          const relIdx = em.index;
          const absRefIdx = scanFrom + relIdx;
          const prefixPart = curBody.slice(0, absRefIdx);
          const prefixTrim = prefixPart.trim();
          const bk = em[2];
          const ch = parseInt(em[3], 10);
          const vRange = em[4].split(/[-~～]/).map((n) => parseInt(n.trim(), 10));
          const v1 = vRange[0];
          const v2 = vRange[1] || v1;
          const short = BOOK_FULL_TO_SHORT.get(bk) || bk;
          const afterPart = (em[5] || '').trim();

          const charBefore = absRefIdx > 0 ? curBody[absRefIdx - 1] : ' ';
          const attachedParenthetical =
            !/[\s.?!:：”"')\]-]/.test(charBefore) &&
            /(?:다|요|죠|함|음|됨|임|니라|리라)$/.test(prefixTrim);
          const afterIsParticle = /^(?:에|에서|의|을|를|이|가|은|는|로|으로|도|만|과|와|참고|참조|비교)(?:\s|$)/.test(afterPart);

          const bibleMatch = !afterIsParticle && afterPart.length >= 6 && doesTextStartBibleVerse(afterPart, short, ch, v1, v2, bibleMaps);
          const heuristicMatch =
            !attachedParenthetical &&
            !afterIsParticle &&
            afterPart.length >= 8 &&
            prefixTrim.length >= 4 &&
            (/[.?!。？！:：”"')\]가-힣]$/.test(prefixTrim) || new RegExp(`^\\(?(?:${BOOK_PATTERN})\\s*\\d`).test(prefixTrim)) &&
            !/(?:은|는|이|가|을|를|의|에|에서|으로|로|와|과|처럼|같이)$/.test(prefixTrim) &&
            (/(?:라|다|노라|니라|도다|소서|요|네|까|면|니|고)[.?!]?$|\(\d+\)|\[\d+\]|\d+[가-힣]/.test(afterPart));

          if (prefixTrim.length >= 4 && (bibleMatch || heuristicMatch)) {
            splitBeforeIdx = absRefIdx;
            break;
          }
          scanFrom = absRefIdx + em[1].length;
        }

        if (splitBeforeIdx > 0) {
          const left = `${curLeadFull}${curBody.slice(0, splitBeforeIdx).trimEnd()}`;
          const right = `${contLead}${curBody.slice(splitBeforeIdx).trimStart()}`;
          stage2Segs.push(left);
          curSeg = right;
          continue;
        }

        // 2b) Check if current line starts with `(BOOK chap:verse) verseText...` AND has glued commentary AFTER the verse end
        const leadRefM = curSeg.match(leadVerseLineRe);
        if (leadRefM) {
          const vLead = leadRefM[1] || '';
          const bk = leadRefM[2];
          const ch = parseInt(leadRefM[3], 10);
          const vRange = leadRefM[4].split(/[-~～]/).map((n) => parseInt(n.trim(), 10));
          const v1 = vRange[0];
          const v2 = vRange[1] || v1;
          const short = BOOK_FULL_TO_SHORT.get(bk) || bk;
          const bodyAfterRef = leadRefM[5] || '';
          const tailSplit = findBibleVerseSplitTailIndex(bodyAfterRef, short, ch, v1, v2, bibleMaps);
          if (tailSplit > 0) {
            const verseOnly = bodyAfterRef.slice(0, tailSplit).trimEnd();
            const commentary = bodyAfterRef.slice(tailSplit).trimStart();
            const normHeader = `(${short} ${ch}:${vRange.join('-')})`;
            stage2Segs.push(`${vLead}${normHeader} ${verseOnly}`);
            curSeg = `${contLead}${commentary}`;
            continue;
          }
        }

        stage2Segs.push(curSeg);
        break;
      }
    }

    for (const s of stage2Segs) {
      out.push(s);
    }
  }

  return out;
}

function hasUnclosedBoldSpan(prevTrimmed, nextTrimmed) {
  if (!prevTrimmed || /^\*\*\s/.test(prevTrimmed)) return false;
  const boldTokens = prevTrimmed.match(/\*\*/g);
  if (!boldTokens || boldTokens.length % 2 === 0) return false;
  if (!/\*\*\S/.test(prevTrimmed)) return false;
  if (/\*\*/.test(nextTrimmed)) return true;
  return /^\*\*(?:\[?\d{1,3}\]?|\([^)]+\))/.test(prevTrimmed);
}

function isDocxHardWrapTail(bodyText, nextTrimmed = '') {
  const b = String(bodyText || '')
    .replace(/<\/?u>/gi, '')
    .replace(/\*\*|__/g, '')
    .trim();
  if (!b) return false;
  if (hasUnclosedInlineBracket(bodyText)) return true;
  if (/,$/.test(b)) return true;
  // Unclosed single quote inside prose e.g. "... 했지 '돈이 필요"
  if (((b.match(/'/g) || []).length % 2 === 1) && /'[가-힣]{1,10}$/.test(b)) return true;
  if (/[.?!。？！"'”’\])…:~-]$|%%$/.test(b) || /\d$/.test(b)) return false;
  // Complete Korean finite sentence endings without period (must NOT be joined across a blank line)
  if (/(?:입니다|습니다|ㅂ니다|합니다|됩니다|바랍니다|니라|리라|도다|노라|지어다|나이다|소서|더라|다|까|군요|네요|세요|어요|아요|해요|예요|에요|죠|아멘)$/.test(b)) {
    return false;
  }
  const nClean = String(nextTrimmed || '').replace(/<\/?u>/gi, '').replace(/\*\*|__/g, '').trim();
  // Context pair 1: Incomplete determiner / adverb / necessity "-아야/-어야/-여야" / modifier "-거" at wrap tail
  if (
    /(?:^|\s)(?:그|이|저|새|옛|온|어느|무슨|자기|각|각각|서로|아무리|비로소|진짜|정말|매우|너무|가장|더욱|점점|계속|항상|이미|아직|결국|갑자기|혼자|함께|같이|따로|직접|스스로|반드시|도리어|오히려|마치|미리|바로|다소|적어도)$/.test(b) ||
    /[가-힣]+히$/.test(b) ||
    (b.length >= 16 && /(?:[가-힣](?:어야|아야|여야)|서야|해야|봐야|와야)$/.test(b)) ||
    /(?:한|된|할|될|인|쓸|쓴|본|온|간|먹은|받은|만든|읽은|들은|배운|믿은|사는|가는|오는|보는|하는|되는)\s?거$/.test(b)
  ) {
    return true;
  }
  // Context pair 2: Unclosed topic/subject ending on parenthetical adverbial ("...것은 사실" + predicate on next line)
  if (/(?:은|는|이|가)\s+[^다요죠.?!]{4,}(?:사실|원래|보통|대개|결국)$/.test(b) && /(?:다|요|죠|음|함|됨)[.?!]?$/.test(nClean)) {
    return true;
  }
  // Context pair 3: Long mid-sentence phrase without nominal ending where next line completes the clause/predicate
  if (
    b.length >= 24 &&
    !/\s\/\s/.test(b) &&
    !/^(?:이래야|그래야|그러므로|따라서|그래서|그러나|하지만|그런데|물론|또한|그리고)(?:$|\s|[가-힣])/.test(nClean) &&
    (
      /^(?:가운데|했던|하였던|해주|주고|받을|조심스럽게|탐스러운|만족하며|가정은|가능했|할지라도|노출|스스로|이세벨|속에서|안에서|위해서|통해서|따라서|대해서|로부터|까지는|조차도|마저도|으로서|으로써|에게서|에게는|으로는|으로의|여길|같으면|같다|같아|한다|된다|있다|없다)(?:$|\s|[가-힣])/.test(nClean) ||
      (nClean.length <= 18 && /(?:한다|된다|있다|없다|같다|싶다|지다|진다|본다|준다|받는다|수 있다|수 없다|것이다|뿐이다|때문이다|말이다)[.?!]?$/.test(nClean) && !/(?:것|상황|시간|부분|이유|목적|문제|예화|결론|배경|본론|서론|박사|목사|장로)$/.test(b))
    )
  ) {
    return true;
  }
  // Ends with incomplete Korean grammatical boundary / modifier / particle / conjunction / adverbial / dangling stem
  return /(?:은|는|이|가|을|를|의|에|서|로|와|과|도|만|며|고|나|면|니|지|게|려|러|할|한|된|될|인|쓸|줄|수|것|뿐|만큼|작건|크건|때문|하여|되어|모든|이런|그런|저런|어떤|이미|그들|하신|주신|되신|계신|오신|가신|순종|생활|자|뿐이요|것이요|아니요|산|온갖|함께|너무|더|가장|매우|필요|보시기|나아가|따라|위해|통해|대해|대한|같은|같이|위한|있는|없는|하는|되는|있|없|하|되)$/.test(b);
}

function shouldMergeProse(prevLine, nextLine, gapCount = 0) {
  if (!prevLine || !nextLine) return false;
  const p = prevLine.trim();
  const n = nextLine.trim();
  if (!p || !n) return false;
  if (/^(?:#{1,6}\s|```|~~~|\|.*\||---+$|\*\*\*+$|<!--)/.test(p)) return false;
  if (/^\*\*[^*\n]+\*\*$/.test(p) || /^\*\*[^*\n]+\*\*$/.test(n)) return false;
  if (/https?:\/\/\S+$/.test(p)) return false;
  if (/^(?:\*\*\d{1,2}[.)]\s+[^*\n]+\*\*|\d{1,2}[.)]\s+\*\*[^*\n]+\*\*)[.?!]?$/.test(p)) return false;
  if (isProtectedLine(nextLine)) return false;
  if (/^(?:\*\*)?\d{1,2}[.)]\s+/.test(n)) return false;
  if (/^(?:강사|장소|날짜|일시|본문|제목|주제|시간|비고|참고)\s*[:：]/.test(p)) return false;
  if (/^(?:강사|장소|날짜|일시|본문|제목|주제|시간|비고|참고)\s*[:：]/.test(n)) return false;
  if (/%%$/.test(p)) return false;

  const isQuotePrev = p.startsWith('>') || BIBLE_REF_HEADER_RE.test(p.replace(/^[-*+>\s]+/, ''));
  const activeVerseQuote = isQuotePrev && hasActiveVerseRangeTail(p, n);
  const unclosedSpan = hasUnclosedInlineBracket(p) || hasUnclosedBoldSpan(p, n) || /^\](?:\{\.underline\})?/.test(n);
  const nextIsInlineUnderline = /^\[[^\]]*\]\{\.underline\}/.test(n) || /^\[[^\]]+$/.test(n);

  // Never merge another '>' blockquote or empty '- >' or new Bible passage header onto the end of prev
  if (/^(?:[-*+]\s*)?>/.test(n)) return false;
  if (BIBLE_REF_HEADER_RE.test(n.replace(/^[-*+>\s]+/, ''))) return false;

  // Inside an active ">..." range verse quote (or unclosed bracket), allow continuing even if next starts with (12) or - (10)
  if (!activeVerseQuote && !unclosedSpan) {
    if (isListLine(nextLine)) return false;
    if (!nextIsInlineUnderline && /^(?:\*\*\s*)?(?:\(|\[|✓|✔|※|예\)|▶|●|■|◆|▲|★|◎|◩|•|◦|▪|\d+[.)]|[①-⑳]|[가-하]\.|[a-zA-Z]\.)/.test(n)) return false;
    if (nextIsInlineUnderline && /^\[\s*(?:마|막|눅|요|행|롬|고전|고후|갈|엡|빌|골|살전|살후|딤전|딤후|딛|몬|히|약|벧전|벧후|요일|이|삼|유|계|창|출|레|민|신)\s*\d+/.test(n)) return false;
    if (new RegExp(`^(?:${BOOK_PATTERN})\\s*\\(?\\d{1,3}\\s*[:：]`).test(n)) return false;
  } else {
    if (isListLine(nextLine) && !/^[-*+]\s+(?:\(\d{1,3}\)|\[\d{1,3}\])/.test(n)) return false;
    // Even inside active verse quote, never merge into headings/symbols/new Bible ref lines/outline items
    if (/^(?:✓|✔|※|예\)|▶|●|■|◆|▲|★|◎|◩|•|◦|▪|[①-⑳]|\d+[.)]|[가-하]\.|[a-zA-Z]\.)/.test(n)) return false;
    if (new RegExp(`^\\(?(?:${BOOK_PATTERN})\\s*\\d{1,3}\\s*[:：]`).test(n)) return false;
  }

  const pCore = p.replace(/^>\s*/, '').replace(/^[-*+]\s+/, '').trim();
  if (!unclosedSpan && !activeVerseQuote && pCore.length < 20) return false;
  if (!activeVerseQuote && !unclosedSpan && p.length > 700 && gapCount > 0) return false;
  if (!activeVerseQuote && !unclosedSpan && p.length > 1400) return false;

  if (unclosedSpan) return true;
  if (activeVerseQuote) return true;

  if (gapCount === 0) {
    if (isQuotePrev && /(?:니라|리라|도다|노라|지어다|나이다|소서|아멘|다|요|라)[.?!]?$/.test(pCore)) return false;
    if (isQuotePrev) {
      const nPlain = n.replace(/\*\*|__|~~|<\/?u>/gi, '').trim();
      if (/(?:다|요|죠|함|음|니다)[.?!]?$/.test(nPlain)) return false;
      return isDocxHardWrapTail(pCore, n);
    }
    if (/[.?!。？！"'”’\])…]$/.test(pCore)) return false;
    return pCore.length >= 26 || isDocxHardWrapTail(pCore, n);
  }

  // Across a single blank line (gapCount === 1): never merge a completed standalone Bible verse into following prose
  if (isQuotePrev) return false;
  return isDocxHardWrapTail(pCore, n);
}

function mergeBrokenLinesPass(lines, vaultBasePath = '') {
  const bibleMaps = getBibleVerseLookup(vaultBasePath);
  const out = [];
  let fence = false;
  let pendingBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    if (/^\s*(?:```|~~~)/.test(cur)) {
      if (pendingBlank) { out.push(''); pendingBlank = false; }
      fence = !fence;
      out.push(cur);
      continue;
    }
    if (!fence && cur.trim() === '') {
      if (out.length > 0 && out[out.length - 1] !== '' && !pendingBlank) {
        pendingBlank = true;
      }
      continue;
    }
    if (!fence && out.length > 0) {
      const prev = out[out.length - 1];
      const gapCount = pendingBlank ? 1 : 0;
      const bibleCont = prev ? doesLineContinueBiblePassage(prev, cur, bibleMaps) : null;
      if (bibleCont) {
        out[out.length - 1] = `${prev.trimEnd()} ${bibleCont.mergedCur}`;
        pendingBlank = false;
        continue;
      }
      if (prev && isBiblePassageCompleteAgainstLookup(prev, cur, bibleMaps)) {
        if (pendingBlank) { out.push(''); pendingBlank = false; }
        out.push(cur);
        continue;
      }
      if (prev && shouldMergeProse(prev, cur, gapCount)) {
        let curClean = cur.trimStart();
        // If unwrapping a mid-verse "- (10) ..." inside an active ">" verse quote, strip redundant bullet dash
        if (prev.trimStart().startsWith('>') && /^-\s+\(\d{1,3}\)/.test(curClean)) {
          curClean = curClean.replace(/^-\s+/, '');
        }
        out[out.length - 1] = `${prev.trimEnd()} ${curClean}`;
        pendingBlank = false;
        continue;
      }
    }
    if (pendingBlank) {
      out.push('');
      pendingBlank = false;
    }
    out.push(cur);
  }
  if (pendingBlank) out.push('');
  return out;
}

function padGeneralStandaloneBibleVerses(lines) {
  const standaloneVerseRe = new RegExp(
    `^[ \\t]*(?:>\\s*)?(?:\\*\\*|__)?[\\[(]\\s*(?:${BOOK_PATTERN})\\s*\\d{1,3}\\s*[:：]\\s*\\d{1,3}(?:\\s*[-~～]\\s*\\d{1,3})?\\s*[\\])](?:\\*\\*|__)?\\s+\\S`
  );
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence && standaloneVerseRe.test(line)) {
      if (out.length > 0 && out[out.length - 1].trim() !== '') {
        out.push('');
      }
      out.push(line);
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      if (next !== null && next.trim() !== '') {
        out.push('');
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

function extractOutlineTagFromContent(text) {
  const t = normalizeTightOutlineSpacing(String(text || '').trim());
  if (!t) return null;
  const symM = t.match(/^([■●◆▲▶★◎◩])\s+(.+)$/);
  if (symM) {
    return { family: `sym_${symM[1]}`, sym: symM[1], rank: 1, ordinal: 0, text: t };
  }
  const romanM = t.match(/^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|[IVX]{1,4})\.\s+(.+)$/);
  if (romanM) {
    return { family: 'roman', rank: 1, ordinal: 0, text: t };
  }
  const numDot = t.match(/^(\d{1,2})\.\s+/);
  if (numDot) return { family: 'num_dot', rank: 2, ordinal: parseInt(numDot[1], 10), text: t };
  const circled = t.match(/^([①-⑳])\s*/);
  if (circled) return { family: 'circled', rank: 3, ordinal: circled[1].charCodeAt(0) - 0x2460 + 1, text: t };
  const halfP = t.match(/^(\d{1,2})\)\s+/);
  if (halfP) return { family: 'half_paren', rank: 4, ordinal: parseInt(halfP[1], 10), text: t };
  const fullP = t.match(/^\((\d{1,2})\)\s+/);
  if (fullP) return { family: 'full_paren', rank: 4.5, ordinal: parseInt(fullP[1], 10), text: t };
  const korDot = t.match(/^([가나다라마바사아자차카타파하])\.\s*/);
  if (korDot) {
    const kOrder = '가나다라마바사아자차카타파하'.indexOf(korDot[1]) + 1;
    return { family: 'kor_dot', rank: 5, ordinal: kOrder, text: t };
  }
  const korP = t.match(/^\(([가나다라마바사아자차카타파하])\)\s*/);
  if (korP) {
    const kOrder = '가나다라마바사아자차카타파하'.indexOf(korP[1]) + 1;
    return { family: 'kor_paren', rank: 6, ordinal: kOrder, text: t };
  }
  const capA = t.match(/^([A-Z])\.\s+(.+)$/);
  if (capA && !/^[A-Z]\./.test(capA[2])) {
    return { family: 'cap_alpha', rank: 4.8, ordinal: capA[1].charCodeAt(0) - 64, text: t };
  }
  const lowA = t.match(/^([a-z])\.\s+(.+)$/);
  if (lowA && !/^[a-z]\./.test(lowA[2])) {
    return { family: 'lower_alpha', rank: 5.8, ordinal: lowA[1].charCodeAt(0) - 96, text: t };
  }
  const alphaP = t.match(/^([a-zA-Z])\)\s*/);
  if (alphaP) {
    return { family: 'alpha_paren', rank: 6, ordinal: alphaP[1].toLowerCase().charCodeAt(0) - 96, text: t };
  }
  return null;
}

function isMajorSymbolFamily(family) {
  return !!family && (family === 'major' || family === 'roman' || family.startsWith('sym_'));
}

function parseReconcileLine(line) {
  const tabsMatch = line.match(/^(\t*)/);
  const tabDepth = tabsMatch ? tabsMatch[1].length : 0;
  const rest = normalizeTightOutlineSpacing(line.slice(tabDepth));
  const h = rest.match(/^(#{1,6})\s+(.+)$/);
  if (h) {
    return {
      kind: 'heading',
      level: h[1].length,
      body: normalizeTightOutlineSpacing(h[2]),
      tabDepth: 0,
      tag: extractOutlineTagFromContent(h[2])
    };
  }
  const b = rest.match(/^(?:-\s+|[ㆍ·•]\s*(?=[①-⑳]|\d{1,2}[.)]|\(\d{1,2}\)|[가-하]\.|[A-Za-z]\.))(.+)$/);
  if (b) {
    const bBody = normalizeTightOutlineSpacing(b[1]);
    return {
      kind: 'bullet',
      level: 99,
      body: bBody,
      orderedMarker: null,
      tabDepth,
      tag: extractOutlineTagFromContent(bBody)
    };
  }
  const ord = rest.match(/^(\d{1,2}[.)])\s+(.+)$/);
  if (ord) {
    return {
      kind: 'bullet',
      level: 99,
      body: `${ord[1]} ${ord[2]}`,
      orderedMarker: ord[1],
      orderedText: ord[2],
      tabDepth,
      tag: extractOutlineTagFromContent(`${ord[1]} ${ord[2]}`)
    };
  }
  return { kind: 'other', raw: line, trimmed: rest.trim(), tag: extractOutlineTagFromContent(rest.trim()) };
}

function isSentenceOrColonProse(body) {
  const b = String(body || '').trim();
  const stripped = b
    .replace(/^(?:[①-⑳]|\d{1,2}[.)]|\(\d{1,2}\)|[가-하]\.|\([가-하]\)|[a-zA-Z][.)])\s*/, '')
    .replace(/\*\*|__|~~|<\/?u>/gi, '')
    .trim();
  if (stripped.length > 56) return true;
  if (/[.?!다요죠]$/.test(stripped)) return true;
  if (/[함음]$/.test(stripped) && (stripped.length > 34 || /,/.test(stripped))) return true;
  if (/:\s+\S{8,}/.test(stripped)) return true; // "결단 : 다니엘은 목숨을 걸고..."
  return false;
}

function isOutlineQuestionHeading(body) {
  const stripped = String(body || '')
    .trim()
    .replace(/^(?:[①-⑳]|\d{1,2}[.)]|\(\d{1,2}\)|[가-하]\.|\([가-하]\)|[a-zA-Z][.)])\s*/, '')
    .replace(/\*\*|__|~~|<\/?u>/gi, '')
    .trim();
  return /\?$/.test(stripped) && stripped.length > 0 && stripped.length <= 32 && !/[.!]/.test(stripped);
}

function isConciseStatementHeading(body) {
  const stripped = String(body || '')
    .trim()
    .replace(/^(?:\d{1,2}[.)]|\(\d{1,2}\))\s*/, '')
    .replace(/\*\*|__|~~|<\/?u>/gi, '')
    .trim();
  if (!stripped || stripped.length > 42 || /[?!]/.test(stripped)) return false;
  if ((stripped.match(/,/g) || []).length >= 2) return false;
  return /(?:다\.)$/.test(stripped);
}

// Detect contiguous inline numbered prose lists like:
//   "그러나 미련한 자는 눈을 땅 끝에 둔다."
//   "1) 구원이 ... 사람이다."
//   "2) 성경에서 ... 사람인 것이다."
//   "3) 무슨 특별한 ... 사람이다."
// where items sit directly under a prose sentence with zero child lines inside the list and every item is a long declarative sentence.
function _outlineFamilyOfParsed(p) {
  if (!p) return '';
  if (p.tag && p.tag.family) return p.tag.family;
  if (p.kind === 'heading_num_candidate' || p.kind === 'ordered_list') return 'num_dot';
  if (p.kind === 'outline_sub') {
    if (/^\d{1,2}\)$/.test(p.marker || '')) return 'half_paren';
    if (/^\(\d{1,2}\)$/.test(p.marker || '')) return 'full_paren';
  }
  return '';
}

function isContiguousProseListAt(parsed, idx, fenced) {
  const cur = parsed[idx];
  const fam = _outlineFamilyOfParsed(cur);
  if (fam !== 'num_dot' && fam !== 'half_paren' && fam !== 'full_paren') return false;

  const isSameCol0 = (p) => {
    if (!p || p.kind === 'heading') return false;
    if (_outlineFamilyOfParsed(p) !== fam) return false;
    if (p.kind === 'bullet') return (p.tabDepth || 0) === 0;
    if (typeof p.indent === 'number') return p.indent === 0;
    return true;
  };

  let start = idx;
  while (start - 1 >= 0 && !(fenced && fenced[start - 1]) && isSameCol0(parsed[start - 1])) {
    start--;
  }
  let end = idx;
  while (end + 1 < parsed.length && !(fenced && fenced[end + 1]) && isSameCol0(parsed[end + 1])) {
    end++;
  }
  const runLen = end - start + 1;
  if (runLen < 2) return false;

  const stripMark = (p) =>
    String((p.tag && p.tag.text) || p.body || '')
      .trim()
      .replace(/^(?:\d{1,2}[.)]|\(\d{1,2}\))\s*/, '')
      .trim();
  const bodies = [];
  for (let k = start; k <= end; k++) {
    bodies.push(stripMark(parsed[k]));
  }
  const allSentenceEnd = bodies.every((b) => /(?:다|요|죠|까|네|라)\.$/.test(b));
  const avgLen = bodies.reduce((s, b) => s + b.length, 0) / bodies.length;
  const minLen = Math.min(...bodies.map((b) => b.length));
  if (!allSentenceEnd || (minLen < 35 && avgLen < 42)) return false;

  // Check if preceded immediately (skipping blanks) by non-heading prose
  let prevIdx = start - 1;
  while (
    prevIdx >= 0 &&
    (parsed[prevIdx].kind === 'blank' || (parsed[prevIdx].kind === 'other' && !parsed[prevIdx].trimmed))
  ) {
    prevIdx--;
  }
  const prev = prevIdx >= 0 ? parsed[prevIdx] : null;
  const prevTxt = (prev && (prev.trimmed || prev.text || '')) || '';
  const precededByProse = !!prev && prev.kind !== 'heading' && !/^>/.test(prevTxt);
  return precededByProse || avgLen >= 42;
}

function formatReconcileListLine(indentUnit, depth, body, orderedMarker) {
  const cleanBody = normalizeTightOutlineSpacing(body);
  if (orderedMarker || /^\d{1,2}[.)]\s+/.test(cleanBody)) {
    return `${indentUnit.repeat(depth)}${cleanBody}`;
  }
  return `${indentUnit.repeat(depth)}- ${cleanBody}`;
}

function stepBulletIndentStack(bulletStack, tag, tabDepth, allowOuterReset) {
  const isNestedOrdinalRestart =
    tag.ordinal === 1 &&
    bulletStack.length > 0 &&
    tabDepth > bulletStack[bulletStack.length - 1].tabDepth;
  let sameFamIdx = -1;
  if (!isNestedOrdinalRestart) {
    for (let k = bulletStack.length - 1; k >= 0; k--) {
      if (bulletStack[k].family === tag.family && (tabDepth >= bulletStack[k].tabDepth || k === 0)) {
        sameFamIdx = k;
        break;
      }
    }
  }
  let newDepth = tabDepth;
  if (sameFamIdx !== -1) {
    if (allowOuterReset && tabDepth === 0 && bulletStack[sameFamIdx].tabDepth > 0) {
      bulletStack.length = 0;
      newDepth = 0;
      bulletStack.push({ tabDepth: 0, rank: tag.rank, family: tag.family });
    } else {
      newDepth = bulletStack[sameFamIdx].tabDepth;
      bulletStack.length = sameFamIdx + 1;
    }
  } else if (bulletStack.length > 0) {
    const top = bulletStack[bulletStack.length - 1];
    if (isNestedOrdinalRestart || tag.rank > top.rank || (tag.ordinal === 1 && tag.family !== top.family)) {
      newDepth = Math.max(tabDepth, top.tabDepth + 1);
      bulletStack.push({ tabDepth: newDepth, rank: tag.rank, family: tag.family });
    } else {
      while (bulletStack.length > 0 && bulletStack[bulletStack.length - 1].rank >= tag.rank) {
        bulletStack.pop();
      }
      newDepth = bulletStack.length > 0 ? Math.max(tabDepth, bulletStack[bulletStack.length - 1].tabDepth + 1) : 0;
      bulletStack.push({ tabDepth: newDepth, rank: tag.rank, family: tag.family });
    }
  } else {
    bulletStack.push({ tabDepth: newDepth, rank: tag.rank, family: tag.family });
  }
  return newDepth;
}

function syncBulletIndentPass(lines, fenced, indentUnit) {
  const out = lines.slice();
  const bulletStack = []; // { tabDepth, rank, family }

  for (let i = 0; i < out.length; i++) {
    if (fenced[i]) { bulletStack.length = 0; continue; }
    const p = parseReconcileLine(out[i]);
    if (p.kind === 'other') {
      if (p.trimmed && !/^[(>]/.test(p.trimmed) && !/^\t/.test(out[i]) && p.trimmed.length > 35) {
        bulletStack.length = 0;
      }
      continue;
    }
    if (p.kind === 'heading') {
      bulletStack.length = 0;
      continue;
    }
    // Bullet or ordered list line
    const tag = p.tag;
    if (tag) {
      const allowOuterReset =
        p.tabDepth === 0 &&
        bulletStack.length > 0 &&
        bulletStack[0].tabDepth > 0 &&
        i > 0 &&
        !out[i - 1].trim();
      const newDepth = stepBulletIndentStack(bulletStack, tag, p.tabDepth, allowOuterReset);
      if (newDepth !== p.tabDepth) {
        out[i] = formatReconcileListLine(indentUnit, newDepth, p.body, p.orderedMarker);
      }
    } else {
      // Un-tagged bullet stays at least as deep as its raw indentation or resets if shallower
      if (p.tabDepth === 0 && bulletStack.length > 0 && bulletStack[0].tabDepth === 0) {
        bulletStack.length = 0;
      }
    }
  }
  return out;
}

function isIntroLeadLine(trimmed) {
  const t = String(trimmed || '').trim();
  if (!t || t.length > 85) return false;
  if (/^[#>]/.test(t) || /\([가-힣]+\s*\d+:\d+/.test(t)) return false;
  if (/[”"']$/.test(t)) return false;
  return /(?:생각해\s*보자|살펴보자|알아보자|나누자|정리해\s*보자|몇\s*가지|다음과\s*같다|아래와\s*같다|가지\s*이유|[:：])\.?$/.test(t);
}

function reconcileDocumentStructure(lines, opts) {
  if (!opts || (!opts.normalizeHierarchy && !opts.respectAiHeadings)) return lines.slice();
  let out = lines.slice();
  const scope = opts.headingLevelScope || 'h1_h6';
  const maxHeadingLevel = scope === 'h1_h2' ? 2 : (scope === 'h1_h3' ? 3 : 6);
  const indentUnit = opts.spacesToTabs === false ? '  ' : '\t';
  const autoNumStyle = opts.autoNumberedStyle || 'smart';
  const isGeneralDoc = opts.docProfile === 'general';
  const skipHeadingRewrite = !!opts.respectAiHeadings;

  let fence = false;
  const fenced = out.map((l) => {
    if (/^\s*(?:```|~~~)/.test(l)) {
      fence = !fence;
      return true;
    }
    return fence;
  });

  if (skipHeadingRewrite) {
    // Only apply general-doc V unwrap and H1-start normalization without overriding user-guided AI headings
    if (isGeneralDoc) {
      let inF = false;
      for (let i = 0; i < out.length; i++) {
        if (/^\s*(?:```|~~~)/.test(out[i])) { inF = !inF; continue; }
        if (inF) continue;
        if (/^[ \t]*[✓✔]\s+/.test(out[i])) out[i] = out[i].replace(/^[ \t]*[✓✔]\s+/, '');
        const mCol0 = out[i].match(/^-\s+(.+)$/);
        if (mCol0) {
          const body = mCol0[1].trim();
          const prevShort = i > 0 && /^-\s+/.test(out[i - 1]) && out[i - 1].length <= 28 && !/[.?!。]$/.test(out[i - 1]);
          const nextShort = i + 1 < out.length && /^-\s+/.test(out[i + 1]) && out[i + 1].length <= 28 && !/[.?!。]$/.test(out[i + 1]);
          if (body.length >= 22 || /[.?!。]["'”’)]*$/.test(body) || !(prevShort || nextShort)) out[i] = body;
        }
      }
    }
    out = normalizeMinHeadingLevelPass(out, true);
    return out;
  }

  // Pass 0: Normalize missing spaces after ■/1./1) and unwrap "- 1) ..." / "- 1. ..." collisions (avoiding "✓ 1)" in sermon-mindmap)
  for (let i = 0; i < out.length; i++) {
    if (fenced[i]) continue;
    const raw = out[i];
    const leadWs = raw.match(/^[ \t]*/)[0];
    const tabsOnly = /\t/.test(leadWs) ? leadWs : indentUnit.repeat(Math.floor(getIndentWidth(leadWs) / 4));
    let rest = normalizeTightOutlineSpacing(raw.slice(leadWs.length).trim());
    if (!rest) { out[i] = ''; continue; }

    // Unwrap "- 1) ..." / "- **1) ...**" / "ㆍ1) ..." -> "1) ..." / "1) **...**"
    const wrapHalf = rest.match(/^(?:-\s+|[ㆍ·•]\s*)(?:\*\*(\d{1,2}\))\*\*\s*(.+)|(\*\*)?(\d{1,2}\))\s*(.+))$/);
    if (wrapHalf) {
      if (wrapHalf[1]) {
        out[i] = `${tabsOnly}${wrapHalf[1]} ${wrapHalf[2]}`;
      } else {
        const bodyHalf = wrapHalf[3] ? `**${wrapHalf[5]}` : wrapHalf[5];
        out[i] = `${tabsOnly}${wrapHalf[4]} ${bodyHalf}`;
      }
      continue;
    }
    // Handle "- 1. ..." / "- **1. ...**" / "ㆍ1. ..." / "- 2. ..."
    const wrapDot = rest.match(/^(?:-\s+|[ㆍ·•]\s*)(?:\*\*(\d{1,2})\.\*\*\s*(.+)|(\*\*)?(\d{1,2})\.\s*(.+))$/);
    if (wrapDot) {
      const nv = parseInt(wrapDot[1] || wrapDot[4], 10);
      const isBoldWrap = !!wrapDot[3];
      const dotBody = wrapDot[1] ? wrapDot[2] : (isBoldWrap ? `**${wrapDot[5]}` : wrapDot[5]);
      if (nv >= 2 && autoNumStyle !== 'to_bullet') {
        out[i] = `${tabsOnly}${nv}. ${dotBody}`;
        continue;
      }
      if (nv === 1) {
        let hasSeq2 = false;
        const curWidth = getIndentWidth(leadWs);
        for (let k = i + 1; k < Math.min(out.length, i + 80); k++) {
          const lk = out[k];
          if (!lk.trim()) continue;
          if (/^#{1,6}\s+/.test(lk.trim())) break;
          const lkWidth = getIndentWidth(lk.match(/^[ \t]*/)[0]);
          if (lkWidth < curWidth) break;
          if (lkWidth === curWidth && /^(?:(?:-\s+|[ㆍ·•]\s*))?(?:\*\*)?2\.\s*/.test(lk.slice(lk.match(/^[ \t]*/)[0].length))) {
            hasSeq2 = true;
            break;
          }
        }
        if ((hasSeq2 || isBoldWrap) && autoNumStyle !== 'to_bullet') {
          out[i] = `${tabsOnly}1. ${dotBody}`;
        } else if (autoNumStyle !== 'keep') {
          out[i] = `${tabsOnly}- ${dotBody}`;
        }
        continue;
      }
    }
    // Fix tight spacing inside markdown headings / plain text while preserving existing indent
    if (rest !== raw.slice(leadWs.length).trim()) {
      out[i] = `${leadWs}${rest}`;
    }
  }

  // Pass 1: Demote child headings sitting under an open bullet & stabilize list stack depth
  const hStack = []; // { level, rank, family }
  const bulletStack = []; // { tabDepth, rank, family }

  for (let i = 0; i < out.length; i++) {
    if (fenced[i]) { hStack.length = 0; bulletStack.length = 0; continue; }
    const p = parseReconcileLine(out[i]);
    if (p.kind === 'other') {
      if (p.trimmed && !/^[(>]/.test(p.trimmed) && !/^\t/.test(out[i]) && p.trimmed.length > 35) {
        bulletStack.length = 0;
      }
      continue;
    }
    if (p.kind === 'bullet') {
      const tag = p.tag;
      if (tag) {
        const allowOuterReset =
          p.tabDepth === 0 &&
          (hStack.some((h) => h.family === tag.family) ||
            (bulletStack.length > 0 && bulletStack[0].tabDepth > 0 && i > 0 && !out[i - 1].trim()));
        const newDepth = stepBulletIndentStack(bulletStack, tag, p.tabDepth, allowOuterReset);
        if (newDepth !== p.tabDepth) {
          out[i] = formatReconcileListLine(indentUnit, newDepth, p.body, p.orderedMarker);
        }
      }
      continue;
    }
    if (p.kind === 'heading') {
      if (p.level <= 2) {
        while (hStack.length > 0 && hStack[hStack.length - 1].level >= p.level) hStack.pop();
        hStack.push({ level: p.level, rank: p.tag ? p.tag.rank : p.level, family: p.tag ? p.tag.family : 'major' });
        bulletStack.length = 0;
        continue;
      }
      if (bulletStack.length > 0 && p.tag && !isMajorSymbolFamily(p.tag.family) && p.tag.family !== 'circled') {
        let sameFamIdx = -1;
        for (let k = bulletStack.length - 1; k >= 0; k--) {
          if (bulletStack[k].family === p.tag.family) { sameFamIdx = k; break; }
        }
        const topB = bulletStack[bulletStack.length - 1];
        const topH = hStack.length > 0 ? hStack[hStack.length - 1] : null;
        const isStartingNewSublist = p.tag.ordinal === 1 && p.tag.family !== (topH && topH.family) && isSentenceOrColonProse(p.body);
        const isSubordinateRank = p.tag.rank > topB.rank;
        if (sameFamIdx !== -1) {
          const d = bulletStack[sameFamIdx].tabDepth;
          bulletStack.length = sameFamIdx + 1;
          out[i] = formatReconcileListLine(indentUnit, d, p.body, /^\d{1,2}[.)]\s/.test(p.body));
          continue;
        }
        if (isSubordinateRank || isStartingNewSublist) {
          const d = topB.tabDepth + 1;
          bulletStack.push({ tabDepth: d, rank: p.tag.rank, family: p.tag.family });
          out[i] = formatReconcileListLine(indentUnit, d, p.body, /^\d{1,2}[.)]\s/.test(p.body));
          continue;
        }
      }
      bulletStack.length = 0;
      while (hStack.length > 0 && hStack[hStack.length - 1].level >= p.level) hStack.pop();
      hStack.push({ level: p.level, rank: p.tag ? p.tag.rank : p.level, family: p.tag ? p.tag.family : '' });
    }
  }

  // Pass 2: Whole-document heading alignment & mixed heading/bullet reconciliation (using a proper heading stack)
  let parsed = out.map((l, idx) => (fenced[idx] ? { kind: 'other' } : parseReconcileLine(l)));

  // Detect if sym_▶ headings appear inside H3+ structural headings (e.g. "### 3) 명예의 유혹" > "## ▶ ...");
  // if so, demote ALL sym_▶ headings cleanly to H4 (#### ▶ ...) so hierarchy is never inverted!
  let arrowHasH3Parent = false;
  let activeStructLevel = 0;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.kind !== 'heading') continue;
    if (p.tag && p.tag.family === 'sym_▶') {
      if (activeStructLevel >= 3) arrowHasH3Parent = true;
    } else if (!p.tag || isMajorSymbolFamily(p.tag.family)) {
      activeStructLevel = p.level;
    } else if (p.tag.family === 'num_dot' || p.tag.family === 'half_paren') {
      activeStructLevel = p.level;
    }
  }

  // 2-sym: Document-wide Same-Symbol Heading Consistency ("■", "●", "◆", "▲", "▶", "★", "◎", "Ⅰ.")
  // If any line with a major symbol got a heading level (e.g. "# ■ ..."), ALL sibling lines with that SAME symbol across the doc get the SAME "#" level.
  const symFamilyMap = new Map();
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p.tag || !isMajorSymbolFamily(p.tag.family)) continue;
    const fam = p.tag.family;
    if (!symFamilyMap.has(fam)) symFamilyMap.set(fam, { headings: [], candidates: [] });
    const entry = symFamilyMap.get(fam);
    if (p.kind === 'heading') {
      entry.headings.push({ idx: i, level: p.level, body: p.body });
    } else if (
      (p.kind === 'other' || (p.kind === 'bullet' && p.tabDepth === 0)) &&
      p.tag.text.length <= 65 &&
      !/[.?!]$/.test(p.tag.text.replace(/[■●◆▲▶★◎◩]\s*/, '').slice(-1))
    ) {
      entry.candidates.push({ idx: i, body: p.tag.text });
    }
  }
  for (const [fam, entry] of symFamilyMap.entries()) {
    if (entry.headings.length === 0) continue;
    let targetLevel = Math.min(maxHeadingLevel, Math.min(...entry.headings.map((h) => h.level)));
    if (fam === 'sym_▶' && arrowHasH3Parent) {
      targetLevel = Math.min(maxHeadingLevel, 4);
    }
    for (const h of entry.headings) {
      if (h.level !== targetLevel) {
        out[h.idx] = `${'#'.repeat(targetLevel)} ${h.body}`;
      }
    }
    for (const c of entry.candidates) {
      out[c.idx] = `${'#'.repeat(targetLevel)} ${c.body}`;
    }
  }

  parsed = out.map((l, idx) => (fenced[idx] ? { kind: 'other' } : parseReconcileLine(l)));

  const NUMERIC_OUTLINE_FAMILIES = new Set(['num_dot', 'half_paren', 'full_paren']);
  const isEligibleOutlineText = (fam, body) =>
    isOutlineQuestionHeading(body) || (NUMERIC_OUTLINE_FAMILIES.has(fam) && isConciseStatementHeading(body));

  // 2-outline-parent: If a section has H1/H2 parent and deeper child headings (e.g. #### ①) below a col-0 numeric outline series (1. / 1) / (1)),
  // ensure that intermediate outline series is promoted to the heading level between parent and child (Korea standard: 1. -> 1) -> (1)/①).
  const koreanRankOfFamily = (fam) => {
    if (isMajorSymbolFamily(fam)) return 1.5;
    if (fam === 'num_dot') return 2;
    if (fam === 'half_paren') return 3;
    if (fam === 'full_paren') return 4;
    if (fam === 'circled' || fam === 'cap_alpha') return 4.5;
    if (fam === 'kor_dot' || fam === 'lower_alpha') return 5.5;
    return 9;
  };
  let secIdx = 0;
  while (secIdx < parsed.length) {
    const sp = parsed[secIdx];
    const secParentLevel = (sp.kind === 'heading' && sp.level <= 2) ? sp.level : 0;
    let secEnd = secIdx + 1;
    while (secEnd < parsed.length) {
      const np = parsed[secEnd];
      if (np.kind === 'heading' && np.level <= (secParentLevel || 1)) break;
      secEnd++;
    }
    const candidatesByFam = new Map();
    const childHeadings = [];
    const hScope = secParentLevel ? [{ idx: secIdx, level: secParentLevel, rank: sp.tag ? koreanRankOfFamily(sp.tag.family) : secParentLevel }] : [];
    for (let j = secIdx + (secParentLevel ? 1 : 0); j < secEnd; j++) {
      const jp = parsed[j];
      if (jp.kind === 'heading' && jp.level >= 2) {
        const jRank = jp.tag ? koreanRankOfFamily(jp.tag.family) : jp.level + 0.5;
        if (jp.level >= 3) childHeadings.push({ idx: j, level: jp.level, rank: jRank });
        while (hScope.length > 0 && hScope[hScope.length - 1].level >= jp.level) hScope.pop();
        hScope.push({ idx: j, level: jp.level, rank: jRank });
      } else if (
        jp.tag &&
        NUMERIC_OUTLINE_FAMILIES.has(jp.tag.family) &&
        ((jp.kind === 'bullet' && jp.tabDepth === 0) || (jp.kind === 'other' && !/^[ \t]/.test(out[j]))) &&
        (jp.tag.family === 'num_dot' || jp.tag.family === 'half_paren'
          ? jp.tag.text.length <= 180
          : (jp.tag.text.length <= 56 && (!isSentenceOrColonProse(jp.tag.text) || isEligibleOutlineText(jp.tag.family, jp.tag.text)) && !isContiguousProseListAt(parsed, j, fenced)))
      ) {
        const famRank = koreanRankOfFamily(jp.tag.family);
        let parentLvl = secParentLevel;
        let parentScopeIdx = secIdx;
        for (let k = hScope.length - 1; k >= 0; k--) {
          if (hScope[k].rank < famRank) {
            parentLvl = hScope[k].level;
            parentScopeIdx = hScope[k].idx;
            break;
          }
        }
        const famBucketKey = `${parentScopeIdx}:${jp.tag.family}`;
        if (!candidatesByFam.has(famBucketKey)) candidatesByFam.set(famBucketKey, []);
        candidatesByFam.get(famBucketKey).push({ idx: j, text: jp.tag.text, parentLvl, parentScopeIdx, fam: jp.tag.family });
      }
    }
    if (childHeadings.length > 0 && candidatesByFam.size > 0) {
      for (const items of candidatesByFam.values()) {
        const fam = items[0].fam;
        const pScopeIdx = items[0].parentScopeIdx;
        const pScopeLvl = items[0].parentLvl;
        const famRank = koreanRankOfFamily(fam);
        const firstIdx = items[0].idx;
        let scopeEnd = secEnd;
        for (let k = firstIdx + 1; k < secEnd; k++) {
          if (parsed[k].kind === 'heading' && parsed[k].level <= pScopeLvl) {
            scopeEnd = k;
            break;
          }
        }
        const deeperChild = childHeadings.find((ch) => ch.idx > firstIdx && ch.idx < scopeEnd && ch.rank > famRank && ch.level >= 3);
        if (!deeperChild) continue;
        const minParentLvl = Math.max(secParentLevel, ...items.map((it) => it.parentLvl));
        if (minParentLvl + 1 > maxHeadingLevel) continue;
        const targetLvl = Math.max(minParentLvl + 1, Math.min(deeperChild.level - 1, famRank));
        if (targetLvl >= 2 && targetLvl <= maxHeadingLevel && targetLvl < deeperChild.level) {
          for (const it of items) {
            out[it.idx] = `${'#'.repeat(targetLvl)} ${it.text}`;
          }
        }
      }
      parsed = out.map((l, idx) => (fenced[idx] ? { kind: 'other' } : parseReconcileLine(l)));
    }
    secIdx = secEnd;
  }

  // 2-outline-doc: Parent-Scoped Outline Family Consistency
  // Unify unpromoted siblings / mixed headings of the SAME outline family under the SAME parent level (never flattening ### 1) under ## 2. up to ## 1)).
  const DOC_ALIGN_FAMILIES = new Set(['num_dot', 'full_paren', 'half_paren', 'cap_alpha', 'lower_alpha', 'kor_dot']);
  const docAlignRanks = { cap_alpha: 1, num_dot: 2, half_paren: 3, full_paren: 4, circled: 4.5, kor_dot: 5, lower_alpha: 5.5 };
  const getParentScopeInfo = (pLines, targetFamilies) => {
    const pStack = []; // { idx, level, family, rank }
    const scopes = new Array(pLines.length).fill(null);
    for (let i = 0; i < pLines.length; i++) {
      const p = pLines[i];
      if (p.kind === 'heading') {
        const fam = p.tag ? p.tag.family : 'major';
        const rank = isMajorSymbolFamily(fam) ? Math.min(p.level, 1.5) : (p.tag ? (docAlignRanks[fam] || p.level) : p.level);
        while (pStack.length > 0 && pStack[pStack.length - 1].level >= p.level) pStack.pop();
        const activeParent = pStack.length > 0 ? pStack[pStack.length - 1] : { idx: -1, level: 0, family: 'root', rank: 0 };
        scopes[i] = activeParent;
        pStack.push({ idx: i, level: p.level, family: fam, rank });
      } else if (p.tag && targetFamilies.has(p.tag.family)) {
        const famRank = docAlignRanks[p.tag.family] || p.tag.rank || 5;
        let par = { idx: -1, level: 0, family: 'root', rank: 0 };
        for (let k = pStack.length - 1; k >= 0; k--) {
          if (pStack[k].family === p.tag.family && (p.tag.family === 'half_paren' || p.tag.family === 'num_dot') && isContiguousProseListAt(pLines, i, fenced)) {
            par = pStack[k];
            break;
          }
          if (pStack[k].family !== p.tag.family && pStack[k].rank < famRank) {
            par = pStack[k];
            break;
          }
        }
        scopes[i] = par;
      }
    }
    return scopes;
  };

  const docAlignedFamilies = new Set();
  for (const fam of DOC_ALIGN_FAMILIES) {
    const isNumericFam = NUMERIC_OUTLINE_FAMILIES.has(fam);
    const scopes = getParentScopeInfo(parsed, DOC_ALIGN_FAMILIES);
    const tierStats = new Map(); // parentLevel -> { headings: [], unpromotedCount: 0, byParentIdx: Map<parentIdx, { headings, unpromoted }> }

    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i];
      if (!p.tag || p.tag.family !== fam) continue;
      const par = scopes[i] || { idx: -1, level: 0 };
      if (!tierStats.has(par.level)) {
        tierStats.set(par.level, { headings: [], unpromotedCount: 0, byParentIdx: new Map() });
      }
      const tier = tierStats.get(par.level);
      if (!tier.byParentIdx.has(par.idx)) {
        tier.byParentIdx.set(par.idx, { headings: [], unpromoted: [] });
      }
      const pBucket = tier.byParentIdx.get(par.idx);

      if (p.kind === 'heading') {
        const hEntry = {
          idx: i,
          parentIdx: par.idx,
          parentLevel: par.level,
          level: p.level,
          ordinal: p.tag.ordinal,
          body: p.body,
          isProse: !isEligibleOutlineText(fam, p.body) && isSentenceOrColonProse(p.body)
        };
        tier.headings.push(hEntry);
        pBucket.headings.push(hEntry);
      } else if ((p.kind === 'bullet' && p.tabDepth === 0) || (p.kind === 'other' && !/^[ \t]/.test(out[i]))) {
        tier.unpromotedCount++;
        pBucket.unpromoted.push(i);
      }
    }

    const docHasProse = Array.from(tierStats.values()).some((t) => t.headings.some((h) => h.isProse));
    if (!isNumericFam && fam !== 'cap_alpha' && docHasProse) continue;

    let changedAny = false;
    for (const [parLevel, tier] of tierStats.entries()) {
      const hList = tier.headings;
      const hasSameFamilyParentBucket = (fam === 'half_paren' || fam === 'num_dot') && Array.from(tier.byParentIdx.keys()).some(
        (pIdx) => pIdx >= 0 && parsed[pIdx] && parsed[pIdx].tag && parsed[pIdx].tag.family === fam
      );
      if (hList.length === 0 && !hasSameFamilyParentBucket) continue;
      if (hList.length === 1 && hList[0].ordinal > 1 && tier.unpromotedCount >= 2) continue;
      if (isNumericFam ? false : hList.some((h) => h.isProse)) continue;

      const minValidLevel = fam === 'cap_alpha' ? 1 : Math.max(2, parLevel + 1);
      const tierTargetLevel = hList.length > 0
        ? Math.min(maxHeadingLevel, Math.max(minValidLevel, Math.min(...hList.map((h) => h.level))))
        : Math.min(maxHeadingLevel, parLevel + 1);

      for (const [parIdx, pBucket] of tier.byParentIdx.entries()) {
        const bh = pBucket.headings;
        const parTagFam = parIdx >= 0 && parsed[parIdx] && parsed[parIdx].tag ? parsed[parIdx].tag.family : '';
        if (hList.length === 0 && parTagFam !== fam) continue;
        const candidateUnpromoted = pBucket.unpromoted.filter((uIdx) => {
          const p = parsed[uIdx];
          if (fam === 'full_paren' && isContiguousProseListAt(parsed, uIdx, fenced)) return false;
          const fitsNumericHeading =
            isNumericFam &&
            p.tag.text.length <= (fam === 'full_paren' ? 62 : 180) &&
            !/%%|\*\*\*/.test(p.tag.text);
          const fitsNonNumericHeading =
            !isNumericFam &&
            p.tag.text.length <= 65 &&
            (!/[.?!다요죠]$/.test(p.tag.text) || isEligibleOutlineText(fam, p.tag.text) || (fam === 'cap_alpha' && p.tag.text.length <= 36 && !/[?!]/.test(p.tag.text))) &&
            !(p.tag.text.length > 44 && /,/.test(p.tag.text));
          return (fitsNumericHeading || fitsNonNumericHeading) && !/^>/.test(p.body);
        });
        // Preserve an already-uniform section if it has zero unpromoted heading-like siblings
        const levelsHere = new Set(bh.map((h) => h.level));
        if (bh.length > 0 && levelsHere.size === 1 && bh[0].level > parLevel && candidateUnpromoted.length === 0) {
          continue;
        }
        if (bh.length === 0 && pBucket.unpromoted.length > candidateUnpromoted.length && isNumericFam && fam === 'full_paren') {
          continue;
        }
        const localTarget = bh.length > 0
          ? Math.min(maxHeadingLevel, Math.max(minValidLevel, Math.min(...bh.map((h) => h.level))))
          : tierTargetLevel;

        for (const h of bh) {
          if (h.level !== localTarget) {
            out[h.idx] = `${'#'.repeat(localTarget)} ${h.body}`;
            changedAny = true;
          }
        }
        for (const uIdx of candidateUnpromoted) {
          const p = parsed[uIdx];
          out[uIdx] = `${'#'.repeat(localTarget)} ${p.tag.text}`;
          changedAny = true;
        }
      }
      docAlignedFamilies.add(fam);
    }
    if (changedAny) {
      parsed = out.map((l, idx) => (fenced[idx] ? { kind: 'other' } : parseReconcileLine(l)));
    }
  }

  // 2-circled-promote: Circled numbers (①..⑳) are deliberate headings; promote each under its nearest parent heading above
  // Also preserve nested ①..⑧ restarts inside a preceding circled heading (e.g. #### ③ -> prose -> ##### ①..⑧).
  const CIRCLES_PARENT_FAMILIES = new Set(['major', 'roman', 'num_dot', 'half_paren', 'full_paren', 'cap_alpha']);
  const circledParentStack = [];
  let activeCircledOuter = null; // { level, ordinal, hadProse }
  for (let i = 0; i < parsed.length; i++) {
    if (fenced[i]) continue;
    const p = parsed[i];
    if (p.kind === 'heading') {
      const fam = p.tag ? p.tag.family : '';
      if (!p.tag || isMajorSymbolFamily(fam) || CIRCLES_PARENT_FAMILIES.has(fam)) {
        while (circledParentStack.length > 0 && circledParentStack[circledParentStack.length - 1] >= p.level) {
          circledParentStack.pop();
        }
        circledParentStack.push(p.level);
        if (activeCircledOuter && p.level <= activeCircledOuter.level) {
          activeCircledOuter = null;
        }
      } else if (fam === 'circled') {
        if (activeCircledOuter && p.level > activeCircledOuter.level) {
          // keep nested
        } else {
          activeCircledOuter = { level: p.level, ordinal: p.tag.ordinal, hadProse: false };
        }
      }
      continue;
    }
    if ((p.kind === 'bullet' || p.kind === 'other') && p.tag && p.tag.family === 'circled' && !/^>/.test(p.body || p.trimmed || '')) {
      const innerBody = p.tag.text.replace(/^[①-⑳]\s*/, '');
      if (!isCircledHeadingBody(innerBody)) continue;
      let parentLvl = circledParentStack.length > 0 ? circledParentStack[circledParentStack.length - 1] : 1;
      if (activeCircledOuter && activeCircledOuter.ordinal >= 2 && activeCircledOuter.hadProse && p.tag.ordinal === 1) {
        parentLvl = Math.max(parentLvl, activeCircledOuter.level);
      }
      const targetLvl = Math.max(2, parentLvl + 1);
      if (targetLvl <= maxHeadingLevel) {
        out[i] = `${'#'.repeat(targetLvl)} ${p.tag.text}`;
        if (!activeCircledOuter || targetLvl <= activeCircledOuter.level) {
          activeCircledOuter = { level: targetLvl, ordinal: p.tag.ordinal, hadProse: false };
        }
      }
      continue;
    }
    if (activeCircledOuter && p.trimmed) {
      activeCircledOuter.hadProse = true;
    }
  }
  parsed = out.map((l, idx) => (fenced[idx] ? { kind: 'other' } : parseReconcileLine(l)));

  // 2a: Align H3~H6 circled headings (①, ②, ③) within the same parent scope AND align mixed num_dot/half_paren siblings
  const headingFamilyGroups = new Map();
  const sectionNumSeries = new Map();
  let curMajorIdx = -1;
  let curMajorLevel = 0;
  let curCircledDepthKey = 0;
  let prevCircledSeen = null;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.kind === 'heading') {
      if (p.level === 1 || (p.level <= 2 && (!p.tag || p.tag.family !== 'sym_▶'))) {
        curMajorIdx = i;
        curMajorLevel = p.level;
        prevCircledSeen = null;
        curCircledDepthKey = 0;
        continue;
      }
      if (p.level >= 3 && p.tag && p.tag.family === 'circled') {
        if (prevCircledSeen && p.level > prevCircledSeen.level && p.tag.ordinal === 1) {
          curCircledDepthKey = prevCircledSeen.level;
        } else if (curCircledDepthKey && p.level <= curCircledDepthKey) {
          curCircledDepthKey = 0;
        }
        prevCircledSeen = { level: p.level, ordinal: p.tag.ordinal };
        const gKey = `${curMajorIdx}:${curCircledDepthKey}:${p.tag.family}`;
        if (!headingFamilyGroups.has(gKey)) headingFamilyGroups.set(gKey, []);
        headingFamilyGroups.get(gKey).push({ idx: i, level: p.level, body: p.body });
      }
      if (p.level >= 2 && p.tag && (p.tag.family === 'num_dot' || p.tag.family === 'half_paren')) {
        const sKey = `${curMajorIdx}:${p.tag.family}`;
        if (!sectionNumSeries.has(sKey)) sectionNumSeries.set(sKey, []);
        sectionNumSeries.get(sKey).push({
          idx: i, kind: 'heading', level: p.level, ordinal: p.tag.ordinal, body: p.body,
          isProse: isSentenceOrColonProse(p.body), underMajorLevel: curMajorLevel
        });
      }
      if (p.level <= 2 && !p.tag) {
        curMajorIdx = i;
        curMajorLevel = p.level;
        prevCircledSeen = null;
        curCircledDepthKey = 0;
      }
      continue;
    }
    if (p.kind === 'bullet' && p.tabDepth === 0 && p.orderedMarker && p.tag && (p.tag.family === 'num_dot' || p.tag.family === 'half_paren')) {
      const sKey = `${curMajorIdx}:${p.tag.family}`;
      if (!sectionNumSeries.has(sKey)) sectionNumSeries.set(sKey, []);
      sectionNumSeries.get(sKey).push({
        idx: i, kind: 'ordered', level: 99, ordinal: p.tag.ordinal, body: p.body,
        orderedMarker: p.orderedMarker, isProse: isSentenceOrColonProse(p.body), underMajorLevel: curMajorLevel
      });
    }
  }
  for (const items of headingFamilyGroups.values()) {
    if (items.length < 2) continue;
    const levels = new Set(items.map((x) => x.level));
    if (levels.size > 1) {
      const targetLevel = Math.min(...items.map((x) => x.level));
      for (const it of items) {
        if (it.level !== targetLevel) {
          out[it.idx] = `${'#'.repeat(targetLevel)} ${it.body}`;
        }
      }
    }
  }
  for (const [sKey, items] of sectionNumSeries.entries()) {
    const fam = sKey.split(':')[1];
    if (docAlignedFamilies.has(fam)) continue;
    if (items.length < 2) continue;
    // Split into monotonic runs (so a new "1., 2." inside a later heading is never merged with an outer "1., 2., 3.")
    const runs = [];
    let curRun = [];
    for (const it of items) {
      if (curRun.length > 0 && it.ordinal <= curRun[curRun.length - 1].ordinal) {
        runs.push(curRun);
        curRun = [it];
      } else {
        curRun.push(it);
      }
    }
    if (curRun.length) runs.push(curRun);

    for (const run of runs) {
      if (run.length < 2) continue;
      const headings = run.filter((x) => x.kind === 'heading');
      const ordered = run.filter((x) => x.kind === 'ordered');
      if (headings.length === 0 || ordered.length === 0) continue;
      // Reconcile unpromoted col-0 1./2./3. or 1)/2)/3) siblings inside the same section into the unified heading level
      const targetLevel = Math.min(maxHeadingLevel, Math.min(...headings.map((h) => h.level)));
      for (const o of ordered) {
        out[o.idx] = `${'#'.repeat(targetLevel)} ${o.body}`;
      }
    }
  }

  parsed = out.map((l, idx) => (fenced[idx] ? { kind: 'other' } : parseReconcileLine(l)));

  // 2b: Group H3~H6 headings & bullets by their TRUE parent heading (popping equal/higher levels or ranks from stack)
  const familyGroups = new Map();
  const h2FamilyStats = new Map(); // tracks (h2Idx:family) -> { headings: [], bullets: [] }
  const scopeStack = []; // { idx, level, rank, family }
  let activeH2 = -1;

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (p.kind === 'heading') {
      if (p.level <= 2) {
        activeH2 = i;
        while (scopeStack.length > 0 && scopeStack[scopeStack.length - 1].level >= p.level) scopeStack.pop();
        scopeStack.push({ idx: i, level: p.level, rank: p.level, family: p.tag ? p.tag.family : 'major' });
        continue;
      }
      const pRank = p.tag ? p.tag.rank : p.level;
      while (
        scopeStack.length > 0 &&
        (scopeStack[scopeStack.length - 1].level >= p.level ||
          (p.tag && scopeStack[scopeStack.length - 1].family === p.tag.family && scopeStack[scopeStack.length - 1].level > 2))
      ) {
        scopeStack.pop();
      }
      const parentIdx = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1].idx : -1;
      if (p.tag && !isMajorSymbolFamily(p.tag.family) && p.tag.family !== 'num_dot') {
        const item = { idx: i, kind: 'heading', level: p.level, tabDepth: 0, body: p.body, orderedMarker: /^\d{1,2}[.)]\s/.test(p.body), isProse: !isEligibleOutlineText(p.tag.family, p.body) && isSentenceOrColonProse(p.body) };
        const key = `${parentIdx}:${p.tag.family}`;
        if (!familyGroups.has(key)) familyGroups.set(key, []);
        familyGroups.get(key).push(item);

        const h2Key = `${activeH2}:${p.tag.family}`;
        if (!h2FamilyStats.has(h2Key)) h2FamilyStats.set(h2Key, []);
        h2FamilyStats.get(h2Key).push(item);
      }
      scopeStack.push({ idx: i, level: p.level, rank: pRank, family: p.tag ? p.tag.family : '' });
      continue;
    }

    if (p.kind === 'bullet' && p.tag && !isMajorSymbolFamily(p.tag.family) && p.tag.family !== 'num_dot') {
      const topScope = scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
      let parentIdx = topScope ? topScope.idx : -1;
      if (topScope && topScope.level > 2 && p.tag.family === topScope.family) {
        parentIdx = scopeStack.length > 1 ? scopeStack[scopeStack.length - 2].idx : -1;
      }
      const item = { idx: i, kind: 'bullet', level: 99, tabDepth: p.tabDepth, body: p.body, orderedMarker: p.orderedMarker, isProse: isSentenceOrColonProse(p.body) };
      const key = `${parentIdx}:${p.tag.family}`;
      if (!familyGroups.has(key)) familyGroups.set(key, []);
      familyGroups.get(key).push(item);

      const h2Key = `${activeH2}:${p.tag.family}`;
      if (!h2FamilyStats.has(h2Key)) h2FamilyStats.set(h2Key, []);
      h2FamilyStats.get(h2Key).push(item);
    }
  }

  for (const [gKey, group] of familyGroups.entries()) {
    const fam = gKey.split(':')[1];
    if (fam === 'circled' || docAlignedFamilies.has(fam)) continue;
    if (group.length < 2) continue;
    const headings = group.filter((g) => g.kind === 'heading');
    const bullets = group.filter((g) => g.kind === 'bullet');
    if (headings.length === 0 || bullets.length === 0) continue;

    const anyProse = headings.some((h) => h.isProse) || bullets.some((b) => b.isProse);
    if (bullets.length >= headings.length || anyProse) {
      const typicalTabDepth = Math.min(...bullets.map((b) => b.tabDepth));
      for (const h of headings) {
        out[h.idx] = formatReconcileListLine(indentUnit, typicalTabDepth, h.body, h.orderedMarker);
        h.kind = 'bullet';
      }
    } else if (headings.length >= 2 && bullets.length === 1 && !bullets[0].isProse && bullets[0].tabDepth === 0) {
      const targetLevel = Math.min(maxHeadingLevel, Math.min(...headings.map((h) => h.level)));
      out[bullets[0].idx] = `${'#'.repeat(targetLevel)} ${bullets[0].body}`;
      bullets[0].kind = 'heading';
      bullets[0].level = targetLevel;
    }
  }

  // 2c: Section-level (H2) consistency for sub-item families like kor_dot
  for (const [h2Key, items] of h2FamilyStats.entries()) {
    const fam = h2Key.split(':')[1];
    if (fam === 'circled' || docAlignedFamilies.has(fam)) continue;
    const headings = items.filter((x) => x.kind === 'heading' && /^#{1,6}\s/.test(out[x.idx]));
    const bullets = items.filter((x) => x.kind === 'bullet' && /^(?:\t*-\s|\t*\d{1,2}[.)]\s)/.test(out[x.idx]));
    if (headings.length > 0 && (bullets.length > headings.length || headings.some((h) => h.isProse))) {
      for (const h of headings) {
        out[h.idx] = formatReconcileListLine(indentUnit, 0, h.body, h.orderedMarker);
      }
    }
  }

  // Pass 3a: Nest subordinate prose / quotes / shallow bullets inside active numbered items ("1) ..." or "1. ...")
  // so subordinate content under "1) ..." never appears as level-0 "✓" at the same rank as "1)"!
  parsed = out.map((l, idx) => (fenced[idx] ? { kind: 'other' } : parseReconcileLine(l)));
  const hasLaterSameOrdSibling = (fromIdx, family, baseDepth) => {
    for (let j = fromIdx + 1; j < out.length; j++) {
      if (fenced[j]) break;
      const np = parsed[j];
      if (np.kind === 'heading') break;
      if (np.kind === 'bullet' && np.orderedMarker && np.tag && np.tag.family === family && np.tabDepth <= baseDepth) {
        return true;
      }
    }
    return false;
  };

  let activeOrd = null; // { tabDepth, family, introBoost }
  let seenBlankSinceOrd = false;
  let lastNonBlankBeforeOrdIdx = -1;
  for (let i = 0; !isGeneralDoc && i < out.length; i++) {
    if (fenced[i]) { activeOrd = null; lastNonBlankBeforeOrdIdx = -1; continue; }
    const p = parsed[i];
    if (p.kind === 'other' && !p.trimmed) {
      if (activeOrd) seenBlankSinceOrd = true;
      continue;
    }
    if (p.kind === 'heading') {
      activeOrd = null;
      seenBlankSinceOrd = false;
      lastNonBlankBeforeOrdIdx = -1;
      continue;
    }
    if (p.kind === 'bullet' && p.orderedMarker && p.tag) {
      let effDepth = p.tabDepth;
      let introBoost = 0;
      if (activeOrd && activeOrd.family === p.tag.family && p.tabDepth <= activeOrd.tabDepth) {
        introBoost = activeOrd.introBoost;
        effDepth = p.tabDepth + introBoost;
      } else if (!activeOrd && p.tabDepth === 0 && lastNonBlankBeforeOrdIdx !== -1 && hasLaterSameOrdSibling(i, p.tag.family, 0)) {
        const prevLine = parsed[lastNonBlankBeforeOrdIdx];
        if (prevLine && prevLine.kind === 'other' && isIntroLeadLine(prevLine.trimmed)) {
          introBoost = 1;
          effDepth = 1;
        }
      }
      if (effDepth !== p.tabDepth) {
        out[i] = formatReconcileListLine(indentUnit, effDepth, p.body, p.orderedMarker);
      }
      activeOrd = { tabDepth: effDepth, family: p.tag.family, introBoost };
      seenBlankSinceOrd = false;
      lastNonBlankBeforeOrdIdx = -1;
      continue;
    }
    if (activeOrd) {
      const betweenSiblings = hasLaterSameOrdSibling(i, activeOrd.family, activeOrd.tabDepth - activeOrd.introBoost);
      if (seenBlankSinceOrd && !betweenSiblings) {
        activeOrd = null;
        if (p.kind === 'other') lastNonBlankBeforeOrdIdx = i;
        continue;
      }
      // Subordinate line under activeOrd: must sit at least 1 tab deeper than activeOrd
      const minChildDepth = activeOrd.tabDepth + 1;
      if (p.kind === 'bullet') {
        const targetD = Math.max(minChildDepth, p.tabDepth + activeOrd.introBoost);
        if (targetD !== p.tabDepth) {
          out[i] = formatReconcileListLine(indentUnit, targetD, p.body, p.orderedMarker);
        }
      } else if (p.kind === 'other' && p.trimmed) {
        const rawIndentTabs = Math.floor(getIndentWidth(out[i].match(/^[ \t]*/)[0]) / 4);
        if (rawIndentTabs < minChildDepth) {
          if (/^>/.test(p.trimmed)) {
            out[i] = `${indentUnit.repeat(minChildDepth)}- ${p.trimmed}`;
          } else {
            out[i] = `${indentUnit.repeat(minChildDepth)}- ${p.trimmed}`;
          }
        }
      }
      seenBlankSinceOrd = false;
      continue;
    }
    if (p.kind === 'other' && p.trimmed) {
      lastNonBlankBeforeOrdIdx = i;
    } else {
      lastNonBlankBeforeOrdIdx = -1;
    }
  }

  // Pass 3b: Under an active heading, nest subordinate prose/quote/detail lines beneath:
  // (1) tightly attached bullets (0 blank lines between "- bullet" and unindented detail lines below it), or
  // (2) sibling short label bullets across blanks ("- 영적 훈련소\n\n교회는..." -> "- 영적 훈련소\n\t- 교회는...")
  const isShortLabelBullet = (p) => (
    p &&
    p.kind === 'bullet' &&
    !p.orderedMarker &&
    p.tabDepth === 0 &&
    !p.tag &&
    p.body.length > 0 &&
    p.body.length <= 32 &&
    !/[.?!다요죠함음]$/.test(p.body) &&
    !/^>/.test(p.body) &&
    !new RegExp(`^\\(?(?:${BOOK_PATTERN})\\s*\\d{1,3}\\s*[:：]`).test(p.body)
  );
  const nestDefOut = [];
  const defParsed = out.map((l, idx) => (fenced[idx] ? { kind: 'other', trimmed: '' } : parseReconcileLine(l)));
  let sawHeadingForDef = false;
  let inDefSeries = false;
  for (let i = 0; i < out.length; i++) {
    if (isGeneralDoc) {
      nestDefOut.push(out[i]);
      continue;
    }
    if (fenced[i]) {
      inDefSeries = false;
      nestDefOut.push(out[i]);
      continue;
    }
    const p = defParsed[i];
    if (p.kind === 'heading') {
      sawHeadingForDef = true;
      inDefSeries = false;
      nestDefOut.push(out[i]);
      continue;
    }
    if (sawHeadingForDef && p.kind === 'bullet' && !p.orderedMarker && p.tabDepth === 0 && !p.tag) {
      const hasImmediateChild =
        i + 1 < out.length &&
        !fenced[i + 1] &&
        defParsed[i + 1].kind === 'other' &&
        !!defParsed[i + 1].trimmed &&
        getIndentWidth(out[i + 1].match(/^[ \t]*/)[0]) === 0 &&
        !/^>/.test(defParsed[i + 1].trimmed) &&
        !isIntroLeadLine(defParsed[i + 1].trimmed);

      const isConciseClauseBullet = p.body.length <= 44 && !/[.?!다요죠]$/.test(p.body) && !/^>/.test(p.body);

      // (1) Tight immediate sub-detail lines directly below a bullet (no blank line gap)
      if (hasImmediateChild && (isConciseClauseBullet || isShortLabelBullet(p))) {
        const tightChildren = [];
        let scan = i + 1;
        while (scan < out.length && tightChildren.length < 8) {
          if (fenced[scan]) break;
          const ps = defParsed[scan];
          if (ps.kind !== 'other' || !ps.trimmed) break;
          const sIndentW = getIndentWidth(out[scan].match(/^[ \t]*/)[0]);
          if (
            sIndentW !== 0 ||
            /^>/.test(ps.trimmed) ||
            isIntroLeadLine(ps.trimmed) ||
            /^(?:강사|장소|날짜|일시|본문|제목|주제|참고|예\))\s*[:：)]/.test(ps.trimmed)
          ) {
            break;
          }
          tightChildren.push(scan);
          scan++;
        }
        if (tightChildren.length > 0) {
          nestDefOut.push(out[i]);
          for (const ci of tightChildren) {
            nestDefOut.push(`${indentUnit}- ${defParsed[ci].trimmed}`);
          }
          inDefSeries = true;
          i = tightChildren[tightChildren.length - 1];
          continue;
        }
      }

      // (2) Spaced sibling short-label bullets across blank lines ("- 영적 훈련소\n\n교회는...")
      if (isShortLabelBullet(p)) {
        const childIndices = [];
        let scan = i + 1;
        let hitSummaryStop = false;
        while (scan < out.length && childIndices.length < 4) {
          if (fenced[scan]) break;
          const ps = defParsed[scan];
          if (ps.kind === 'other' && !ps.trimmed) {
            scan++;
            continue;
          }
          const sIndentW = getIndentWidth(out[scan].match(/^[ \t]*/)[0]);
          if (
            ps.kind === 'other' &&
            ps.trimmed &&
            sIndentW === 0 &&
            !isIntroLeadLine(ps.trimmed) &&
            !/^(?:강사|장소|날짜|일시|본문|제목|주제|참고|예\))\s*[:：)]/.test(ps.trimmed)
          ) {
            if (inDefSeries && /^(?:이처럼|그러므로|따라서|결론적으로)\s/.test(ps.trimmed) && childIndices.length >= 1) {
              hitSummaryStop = true;
              break;
            }
            childIndices.push(scan);
            scan++;
            continue;
          }
          break;
        }
        if (childIndices.length > 0) {
          let afterIdx = scan;
          while (afterIdx < out.length && !fenced[afterIdx] && defParsed[afterIdx].kind === 'other' && !defParsed[afterIdx].trimmed) afterIdx++;
          const pk = afterIdx < out.length ? defParsed[afterIdx] : null;
          const nextIsSiblingBullet = isShortLabelBullet(pk);
          const closesSeries = inDefSeries && (hitSummaryStop || !pk || pk.kind === 'heading' || (pk.kind === 'bullet' && pk.orderedMarker));
          if (nextIsSiblingBullet || closesSeries) {
            nestDefOut.push(out[i]);
            for (const ci of childIndices) {
              nestDefOut.push(`${indentUnit}- ${defParsed[ci].trimmed}`);
            }
            inDefSeries = true;
            i = childIndices[childIndices.length - 1];
            continue;
          }
        }
      }
      inDefSeries = false;
    } else if (p.kind !== 'other' || p.trimmed) {
      inDefSeries = false;
    }
    nestDefOut.push(out[i]);
  }
  out = nestDefOut;

  // Pass 3c: Re-sync bullet nesting depths cleanly after any Pass 2/3a/3b updates
  out = syncBulletIndentPass(out, fenced, indentUnit);

  // Pass 4: Dedent orphaned tab-indented bullet blocks sitting directly beneath a heading
  // (e.g. "## 9. ...\n\t- item" -> "## 9. ...\n- item") so Obsidian renders clean '•' bullets without '✓ -'.
  {
    let afterHeadingNoCol0Body = false;
    let activeDedentShift = 0;
    let inFence4 = false;
    for (let i = 0; i < out.length; i++) {
      if (/^\s*(?:```|~~~)/.test(out[i])) {
        inFence4 = !inFence4;
        afterHeadingNoCol0Body = false;
        activeDedentShift = 0;
        continue;
      }
      if (inFence4) continue;
      if (!out[i].trim()) continue;
      const p = parseReconcileLine(out[i]);
      if (p.kind === 'heading') {
        afterHeadingNoCol0Body = true;
        activeDedentShift = 0;
        continue;
      }
      if (afterHeadingNoCol0Body) {
        if (p.kind === 'bullet' && !p.orderedMarker) {
          if (p.tabDepth > 0) {
            activeDedentShift = p.tabDepth;
            afterHeadingNoCol0Body = false;
            out[i] = formatReconcileListLine(indentUnit, 0, p.body, null);
            continue;
          }
          afterHeadingNoCol0Body = false;
          activeDedentShift = 0;
          continue;
        }
        afterHeadingNoCol0Body = false;
        activeDedentShift = 0;
        continue;
      }
      if (activeDedentShift > 0) {
        if (p.kind === 'bullet' && p.tabDepth >= activeDedentShift) {
          const newD = p.tabDepth - activeDedentShift;
          if (newD === 0 && p.orderedMarker) {
            activeDedentShift = 0;
          } else {
            out[i] = formatReconcileListLine(indentUnit, newD, p.body, p.orderedMarker);
          }
          continue;
        }
        activeDedentShift = 0;
      }
    }
  }

  // Pass 5 (general document profile): unwrap literal ✓/✔, level-0 '-' ('V' mark), & indented prose bullets cleanly
  if (isGeneralDoc) {
    let inFence5 = false;
    for (let i = 0; i < out.length; i++) {
      if (/^\s*(?:```|~~~)/.test(out[i])) { inFence5 = !inFence5; continue; }
      if (inFence5) continue;
      if (/^[ \t]*(?:-\s+)?[✓✔]\s+/.test(out[i])) {
        out[i] = out[i].replace(/^[ \t]*(?:-\s+)?[✓✔]\s+/, '');
        continue;
      }
      const mCol0 = out[i].match(/^-\s+(.+)$/);
      if (mCol0) {
        const body = mCol0[1].trim();
        const prevShortDash = i > 0 && /^-\s+/.test(out[i - 1]) && out[i - 1].length <= 28 && !/[.?!。]$/.test(out[i - 1]);
        const nextShortDash = i + 1 < out.length && /^-\s+/.test(out[i + 1]) && out[i + 1].length <= 28 && !/[.?!。]$/.test(out[i + 1]);
        if (body.length >= 22 || /[.?!。]["'”’)]*$/.test(body) || !(prevShortDash || nextShortDash)) {
          out[i] = body;
        }
        continue;
      }
      const mIndentedProse = out[i].match(/^\t+-\s+(.+)$/);
      if (mIndentedProse) {
        const body = mIndentedProse[1].trim();
        if (body.length >= 20 || /[.?!。]["'”’)]*$/.test(body)) {
          out[i] = body;
        }
      }
    }
  }

  // Pass 6: Option B — If doc has 1 lone plain document title (# Title) at top above >=2 ## ■/major sections,
  // demote that top title to bold text and shift all ## ■ -> # ■, ### -> ##, #### -> ### cleanly!
  out = demoteLoneDocTitleIfMajorH2(out, isGeneralDoc);
  const hasH2MajorOnly = !out.some((l) => /^#\s+/.test(l.trim())) && out.some((l) => /^##\s+(?:[■●◆▲▶★◎◩]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.)/.test(l.trim()));
  const shouldShiftToH1 = isGeneralDoc || !!opts.preserveExistingHeadings || hasH2MajorOnly;
  out = normalizeMinHeadingLevelPass(out, shouldShiftToH1);

  return out;
}

function demoteLoneDocTitleIfMajorH2(lines, isGeneralDoc = false) {
  const out = lines.slice();
  let inFence = false;
  const h1s = [];
  const h2s = [];
  for (let i = 0; i < out.length; i++) {
    if (/^\s*(?:```|~~~)/.test(out[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = out[i].match(/^(#{1,6})\s+(.+)$/);
    if (!m) continue;
    if (m[1].length === 1) h1s.push({ idx: i, text: m[2].trim() });
    else if (m[1].length === 2) h2s.push({ idx: i, text: m[2].trim() });
  }
  if (h1s.length === 1 && h2s.length >= 2 && h1s[0].idx < h2s[0].idx && h1s[0].idx <= 3) {
    const hasProseBeforeH1 = out.slice(0, h1s[0].idx).some((l) => l.trim() !== '');
    if (hasProseBeforeH1) return out;
    const title = h1s[0].text;
    const isPlainDocTitle = !/^(?:[■●◆▲▶★◎◩※]|\d{1,3}[.)]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.)/.test(title);
    const hasMajorH2Symbols = h2s.some((h) => /^(?:[■●◆▲▶★◎◩]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.)/.test(h.text));
    if (isPlainDocTitle && (hasMajorH2Symbols || isGeneralDoc)) {
      const clean = title.replace(/^\*\*(.+)\*\*$/, '$1');
      out[h1s[0].idx] = `**${clean}**`;
    }
  }
  return out;
}

function normalizeMinHeadingLevelPass(lines, shiftToH1 = false) {
  const out = lines.slice();
  let inFence = false;
  const heads = [];
  for (let i = 0; i < out.length; i++) {
    if (/^\s*(?:```|~~~)/.test(out[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = out[i].match(/^(#{1,6})\s+(.+)$/);
    if (m) heads.push({ idx: i, level: m[1].length, text: m[2] });
  }
  if (!heads.length) return out;
  const minLvl = Math.min(...heads.map((h) => h.level));
  if (shiftToH1 && minLvl > 1) {
    const shift = minLvl - 1;
    for (const h of heads) {
      h.level = Math.max(1, h.level - shift);
      out[h.idx] = `${'#'.repeat(h.level)} ${h.text}`;
    }
  }
  return out;
}

function extractLeadingMetadataFrontmatter(rawLines) {
  const meta = {};
  let consumed = 0;
  for (let i = 0; i < Math.min(rawLines.length, 6); i++) {
    const t = rawLines[i].trim();
    if (!t) { consumed = i + 1; continue; }
    const kv = t.match(/^(강사|장소|날짜|일시|본문|제목|성격)\s*[:：]\s*(.+)$/);
    if (kv) {
      meta[kv[1]] = kv[2].trim();
      consumed = i + 1;
    } else {
      break;
    }
  }
  if (Object.keys(meta).length === 0) return { generatedFm: '', startIdx: 0 };
  const yamlLines = ['---'];
  yamlLines.push(`날짜: ${meta['날짜'] || meta['일시'] || ''}`);
  yamlLines.push(`본문: ${meta['본문'] || ''}`);
  if (meta['강사']) yamlLines.push(`강사: ${meta['강사']}`);
  if (meta['장소']) yamlLines.push(`장소: ${meta['장소']}`);
  yamlLines.push('tags: []');
  yamlLines.push('---');
  return { generatedFm: yamlLines.join('\n') + '\n', startIdx: consumed };
}

/**
 * AI 없이 동작하는 오프라인 한국어 띄어쓰기 보정 (인라인 코드/링크/URL/HTML 태그 보호, 멱등성 보장)
 */
function fixKoreanSpacingOffline(line) {
  if (!line || !/[가-힣]{4,}/.test(line)) return line;
  const saved = [];
  let work = String(line).replace(/(`[^`]+`|!\[\[[^\]]+\]\]|\[\[[^\]]+\]\]|https?:\/\/[^\s)]+|<[^>]+>)/g, (m) => {
    saved.push(m);
    return `\uE000${saved.length - 1}\uE001`;
  });

  const applySpacingPass = (s) => {
    // 0. 마침표(.)·쉼표(,) 뒤에 공백 없이 바로 한글/숫자/여는 괄호가 붙은 경우 (소수/장절/날짜 숫자.숫자 및 천단위 1,000 제외)
    s = s.replace(/([가-힣\)”’"']\.)(?=[가-힣0-9\(“‘"'])/g, '$1 ');
    s = s.replace(/([가-힣\)”’"'],)(?=[가-힣\(“‘"'])/g, '$1 ');
    // 숫자+단위('2차전도여행', '약300년정도된') 분리
    s = s.replace(/(^|\s)(약|총|매|각)(\d+)/g, '$1$2 $3');
    s = s.replace(/(\d+[차회번개명권장절편월일])(?=[가-힣]{2,})/g, '$1 ');
    s = s.replace(/(\d+(?:년|개월|일|명|권|차))(정도|가량|여|쯤|이상|이하|미만|전후)(?=[가-힣]*)/g, '$1 $2 ');

    // 1. 설교·신학 빈출 붙여쓰기 구문
    const exactPairs = [
      [/하나님의은혜/g, '하나님의 은혜'],
      [/하나님의말씀/g, '하나님의 말씀'],
      [/하나님의사랑/g, '하나님의 사랑'],
      [/하나님의나라/g, '하나님의 나라'],
      [/하나님의영광/g, '하나님의 영광'],
      [/하나님의백성/g, '하나님의 백성'],
      [/하나님의자녀/g, '하나님의 자녀'],
      [/하나님의능력/g, '하나님의 능력'],
      [/하나님의뜻/g, '하나님의 뜻'],
      [/예수그리스도/g, '예수 그리스도'],
      [/성령하나님/g, '성령 하나님'],
      [/성경말씀/g, '성경 말씀'],
      [/뿐만아니라/g, '뿐만 아니라'],
      [/그뿐만아니라/g, '그뿐만 아니라'],
      [/그렇기때문에/g, '그렇기 때문에'],
      [/그럼에도불구하고/g, '그럼에도 불구하고'],
      [/이네권의/g, '이 네 권의'],
      [/이두권의/g, '이 두 권의'],
      [/이세권의/g, '이 세 권의'],
    ];
    for (const [re, rep] of exactPairs) s = s.replace(re, rep);

    // 2. 긴 한글 어절(5자 이상) 내부의 명확한 조사·어미·의존명사·보조용언 경계 분리
    s = s.replace(/[가-힣]{5,}/g, (tok) => {
      let t = tok;
      // 2a. 자주 붙는 전치/접속 구문 ('에대해', '을통해', '을위해', '로인해' 등)
      t = t.replace(/([가-힣]{1,})(에대해|에대한|에대하여|에관해|에관한|에따라|에따른|에의해|에의한|을통해|를통해|을통하여|를통하여|을위해|를위해|을위하여|를위하여|로인해|로인하여|으로인해|으로인하여)(?=[가-힣]*)/g, (_, a, b) => {
        return `${a}${b[0]} ${b.slice(1)} `;
      });
      // 2b. ㄹ받침 관형형 + '수 있/없' (할수있다, 감당할수있다, 깨달을수없다 등)
      t = t.replace(/([가-힣]+)수(있|없)(?=[가-힣])/g, (m, stem, v) => {
        const lastCode = stem.charCodeAt(stem.length - 1);
        if (lastCode >= 0xAC00 && lastCode <= 0xD7A3 && (lastCode - 0xAC00) % 28 === 8) {
          return `${stem} 수 ${v}`;
        }
        return m;
      });
      // 2c. 관형형 + '것이다/것입니다/것을/것이/것은/것도/것으로/것처럼/때문/사람들/목적/이유/의미'
      t = t.replace(/([가-힣]*(?:진|한|할|된|될|인|있는|없는|하는|되는|받는|주는|믿는|보는|가는|오는|좋은|크신|많은|적은|새로운|귀한|참된|영원한|분명한|정확한|모든|어떤|이런|그런|저런))(것은|것이|것을|것도|것이다|것입니다|것이었다|것이었으며|것이며|것이고|것으로|것처럼|것과|것에|사람들|사람이|사람은|목적을|목적이|목적은|이유가|이유는|이유를|의미가|의미는|의미를)(?=[가-힣]*)/g, '$1 $2');
      t = t.replace(/([가-힣]{2,})(때문(?:에|이|이다|입니다))(?=[가-힣]*)/g, '$1 $2');
      t = t.replace(/([가-힣]{2,})(중이다|중인|중이며|중이었다)/g, '$1 $2');
      t = t.replace(/(정도|가량)(된|되는|걸린|지난|남은)/g, '$1 $2');
      // 2d. 보조용언 '~고 있~', '~야 한/할/함', '~라고 한다', 종결어미 뒤 문장 붙음
      t = t.replace(/([가-힣]{2,})(하고|되고|가고|오고|보고|알고|믿고|살고|듣고|받고|쓰고|읽고)(있[다는데어었습니])/g, '$1$2 $3');
      t = t.replace(/([가-힣]{2,})(해야|되어야|돼야|가야|와야|봐야|알아야|믿어야|살아야)(한|할|함|했)/g, '$1$2 $3');
      t = t.replace(/([가-힣]{2,})(이라고|라고)(한다|했다|하였다|말한다|부른다|생각한다|여긴다|불린다|볼수|할수)/g, '$1$2 $3');
      t = t.replace(/(것은|것이|것을|것도)(아니다|아니라|아닌|있다|없다|같다)/g, '$1 $2');
      t = t.replace(/([가-힣]{2,})(있다|없다|아니다|한다|했다|하였다|된다|되었다|됐다|하신다|하시다|입니다|합니다|했습니다|됩니다|되었습니다)(?=[가-힣]{2,})/g, '$1$2 ');
      // 2e. 접속사/부사/주요 주어+조사 뒤 분리
      t = t.replace(/(그리고|그러나|그런데|하지만|그러므로|따라서|그래서|왜냐하면|또한|역시|특히|반드시|항상|이미|아직|결코|오직|다만|비록|만약|만일|결국|실제로|실로|참으로|분명히|성경은|하나님은|하나님이|하나님께|하나님을|예수님은|예수님이|예수님을|성령님은|성령님이|성령을|바울은|바울이|바울을|베드로는|베드로가|모세는|모세가|다윗은|다윗이|아브라함은|아브라함이|우리는|우리가|우리를|우리에게)(?=[가-힣]{2,})/g, '$1 ');
      // 2f. 관형사/자주 쓰는 관형형 + 2자 이상 명사 (대한민국/대한예수교 제외)
      t = t.replace(/([가-힣]{1,}에)(대한|관한|따른|위한|통한)(?!민국|예수교)([가-힣]{2,})/g, '$1 $2 $3');
      t = t.replace(/^(대한|관한|따른|위한|통한)(?!민국|예수교)([가-힣]{3,})/g, '$1 $2');
      t = t.replace(/(정확한|분명한|새로운|참된|귀한|영원한|거룩한|완전한|충분한|필요한|중요한|올바른|진실한|모든)([가-힣]{2,})/g, '$1 $2');
      // 2g. 2자 이상 명사 + 조사(의/을/를/이/가/에서/에게/으로/로) + 명확한 후속 단어/부사/접속사
      t = t.replace(/([가-힣]{2,})(의)(하나님|예수|그리스도|성령|말씀|은혜|사랑|뜻|나라|영광|능력|이름|백성|자녀|교회|믿음|소망|구원|십자가|복음|진리|생명|마음|삶|모든|참된|새로운|거룩한)/g, '$1$2 $3');
      t = t.replace(/([가-힣]{2,})(을|를|은|는|이|가|에|에서|에게|로|으로|와|과)(어떻게|왜|언제|어디서|무엇을|누가|누구|얼마나|이렇게|그렇게|저렇게|이처럼|그처럼|함께|같이|항상|계속|바로|직접|사랑|감사|찬양|기도)/g, '$1$2 $3');
      t = t.replace(/([가-힣]{2,})(을|를)(통해|통하여|위해|위하여|따라|향해|향하여|가지고|갖고|믿고|알고|보고|듣고|받고|주고|하고|되고|지키고|사랑하고|이해하고|깨닫고|기억하고|전하고|선포하고|찬양하고|경배하고|기도하고|구하는|찾는|얻는|누리는|이루는|드리는|섬기는)(?=[가-힣]*)/g, '$1$2 $3');
      t = t.replace(/([가-힣]{2,})(이|가)(된|되는|되어|될|많기|적기|있기|없기|있는|없는|있다|없다|있고|없고|아니다|아니라|아닌)(?=[가-힣]*)/g, '$1$2 $3');
      t = t.replace(/([가-힣]{2,})(으로|로)(구원|말미암|인해|인하여|나아|향하|변화|회복|살아|들어가|나아가)/g, '$1$2 $3');
      t = t.replace(/([가-힣]{2,})(에서|에게서|에게는|에서도|으로는|으로서|으로써)(?=[가-힣]{2,})/g, '$1$2 ');
      t = t.replace(/([가-힣]{2,})(그러면|그러므로|그러나|그런데|따라서|그래서)(?=[가-힣]*)/g, '$1 $2');
      return t.replace(/ {2,}/g, ' ').trim();
    });
    return s;
  };

  for (let pass = 0; pass < 3; pass++) {
    const next = applySpacingPass(work);
    if (next === work) break;
    work = next;
  }
  work = work.replace(/ {2,}/g, ' ');
  return work.replace(/\uE000(\d+)\uE001/g, (_, idx) => saved[Number(idx)] || '');
}

function refineMarkdownByRules(rawText, options = {}) {
  const opts = Object.assign({}, DEFAULT_SETTINGS, options);
  const { frontmatter, body } = splitFrontmatter(rawText);
  let text = convertHtmlParagraphAndBreakTags(
    normalizeHwpDashBullets(unescapePandocMarkdown(decodeHtmlEntities(body)))
  )
    .replace(/[\u00A0\u200B\uFEFF]/g, (ch) => (ch === '\u00A0' ? ' ' : ''));

  let rawLines = text.split('\n').map((l) => l.replace(/[ \t]+$/g, ''));
  // Normalize HTML/Pandoc wrappers, leading '-' on '>' verse lines when stripping quotes, etc.
  if (opts.stripVerseBlockquotes) {
    rawLines = rawLines.map((l) => normalizeBibleRefsInLine(l, false, true));
  }
  const isGeneralDoc = opts.docProfile === 'general';
  rawLines = splitInlineNumberedItemsPass(rawLines, isGeneralDoc);
  if (opts.normalizeBibleRefs) {
    rawLines = splitAndNormalizeBiblePassagesPass(rawLines, opts);
  }
  if (opts.mergeBrokenLines) {
    rawLines = mergeBrokenLinesPass(rawLines, opts.vaultBasePath || '');
  }
  rawLines = convertPandocUnderlineTags(rawLines.join('\n')).split('\n');
  const hasExistingHeadings = rawLines.some((l) => /^#{1,6}\s+/.test(l.trim()));
  const hasExistingH2 = rawLines.some((l) => /^##\s+/.test(l.trim()));
  const hasStructuralH2 = rawLines.some((l) => /^##\s+(?![▶►▷])/.test(l.trim()));
  const hasExplicitNumDotHeading = rawLines.some((l) => /^#{1,6}\s+\d{1,2}\.\s/.test(l.trim()));
  const hasExplicitFullParenHeading = rawLines.some((l) => /^#{1,6}\s+\(\d{1,2}\)\s/.test(l.trim()));
  const scope = opts.headingLevelScope || 'h1_h6';
  const maxHeadingLevel = scope === 'h1_h2' ? 2 : (scope === 'h1_h3' ? 3 : 6);
  const autoNumStyle = opts.autoNumberedStyle || 'smart';

  // First pass: optional frontmatter extraction if missing
  let generatedFm = '';
  let startIdx = 0;
  if (!frontmatter && opts.addMissingFrontmatter) {
    const ext = extractLeadingMetadataFrontmatter(rawLines);
    generatedFm = ext.generatedFm;
    startIdx = ext.startIdx;
  }

  // Second pass: normalize hierarchy (H1~H6 headings & tab-indented list nesting)
  const processedLines = [];
  let inFence = false;
  const indentStack = []; // tracks indent widths for list nesting -> tabs
  const headingStack = []; // tracks active heading ranks -> markdown heading levels 1..6
  let hadProseSinceHeading = false;

  const pushHeadingRank = (rank, minLevel, titleText, extra = null) => {
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].rank >= rank) {
      headingStack.pop();
    }
    const parentLevel = headingStack.length > 0 ? headingStack[headingStack.length - 1].level : 0;
    const level = Math.max(minLevel, parentLevel + 1);
    if (level > maxHeadingLevel) {
      return null;
    }
    headingStack.push(Object.assign({ rank, level }, extra || {}));
    indentStack.length = 0;
    hadProseSinceHeading = false;
    return `${'#'.repeat(level)} ${titleText}`;
  };

  const parsedLines = rawLines.map((l) => classifyOutlineLine(l));
  const hasDocHalfParenSub = parsedLines.some(
    (pl) => pl.kind === 'outline_sub' && /^\d{1,2}\)$/.test(pl.marker || '') && pl.canBeHeading
  );
  const hasTopLevelSymOrRoman = parsedLines.some(
    (pl) =>
      (pl.kind === 'heading_sym' && (pl.sym === '●' || pl.sym === '■')) ||
      pl.kind === 'heading_roman' ||
      (pl.kind === 'heading' && pl.level === 1)
  );
  const hasDocSymOrRoman = parsedLines.some(
    (pl) =>
      (pl.kind === 'heading_sym' && (pl.sym === '●' || pl.sym === '■')) ||
      pl.kind === 'heading_roman'
  );
  const capAlphaItems = [];
  for (let idx = startIdx; idx < parsedLines.length; idx++) {
    const pl = parsedLines[idx];
    if (pl.kind === 'outline_sub' && pl.indent === 0 && /^[A-Z]\.$/.test(pl.marker || '')) {
      capAlphaItems.push({ idx, marker: pl.marker });
    }
  }
  const hasCapAlphaSeries = capAlphaItems.length >= 2 && capAlphaItems.some((c) => c.marker === 'A.');
  let hasStructAboveFirstAlpha = false;
  if (hasCapAlphaSeries) {
    const firstAlphaIdx = capAlphaItems[0].idx;
    for (let idx = startIdx; idx < firstAlphaIdx; idx++) {
      const pl = parsedLines[idx];
      if (
        pl.kind === 'heading_sym' ||
        pl.kind === 'heading_roman' ||
        pl.kind === 'heading_num_candidate' ||
        (pl.kind === 'heading' && pl.level >= 2)
      ) {
        hasStructAboveFirstAlpha = true;
        break;
      }
    }
  }
  const capAlphaAsTopLevel = hasCapAlphaSeries && !hasDocSymOrRoman && !hasStructAboveFirstAlpha;
  let activeCircledPass = null; // { level, ordinal, hadProse }
  const hasFollowingCircledTwo = (fromIdx) => {
    for (let j = fromIdx + 1; j < parsedLines.length; j++) {
      const pl = parsedLines[j];
      if (pl.kind === 'heading_sym' || pl.kind === 'heading_roman' || pl.kind === 'heading_num_candidate') break;
      if (pl.kind === 'heading' && pl.level <= 2) break;
      if (pl.kind === 'outline_sub' && pl.marker === '②') return true;
      if (pl.kind === 'heading' && /^#{1,6}\s+②/.test(pl.text)) return true;
    }
    return false;
  };

  const hasOrderedSibling = (idx, targetIndent) => {
    const curKind = parsedLines[idx] ? parsedLines[idx].kind : '';
    const allowWideTopScan = targetIndent === 0 && curKind === 'heading_num_candidate';
    for (let dir of [-1, 1]) {
      let plainSkipped = 0;
      let crossedMajorHeading = false;
      for (let j = idx + dir; j >= startIdx && j < parsedLines.length; j += dir) {
        const cand = parsedLines[j];
        if (cand.kind === 'heading_sym' || cand.kind === 'heading_roman') {
          if (!allowWideTopScan) break;
          crossedMajorHeading = true;
          continue;
        }
        if (cand.kind === 'heading') {
          if (!allowWideTopScan || cand.level <= 1 || (cand.level === 2 && !/^##\s*[▶►▷]/.test(cand.text))) {
            if (!allowWideTopScan) break;
            crossedMajorHeading = true;
          }
          continue;
        }
        if (cand.kind === 'blank') {
          if (!allowWideTopScan && targetIndent === 0) break;
          continue;
        }
        if (cand.kind === 'plain' && cand.indent <= targetIndent) {
          plainSkipped++;
          if (!allowWideTopScan && (dir === -1 || plainSkipped > 3)) break;
          continue;
        }
        if ((cand.kind === 'ordered_list' || cand.kind === 'heading_num_candidate' || cand.kind === 'bullet') && cand.indent < targetIndent) break;
        if ((cand.kind === 'ordered_list' || cand.kind === 'heading_num_candidate') && cand.indent === targetIndent) {
          if (cand.numVal === 1 && dir === 1) break;
          if (crossedMajorHeading) {
            if (dir === 1 && cand.kind === 'heading_num_candidate' && cand.numVal === 2) return true;
            continue;
          }
          if (cand.numVal >= 2 && cand.numVal <= 30) return true;
        }
      }
    }
    return false;
  };

  for (let i = startIdx; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      processedLines.push(line);
      continue;
    }
    if (inFence) {
      processedLines.push(line);
      continue;
    }

    const info = parsedLines[i];
    if (info.kind === 'blank') {
      processedLines.push('');
      continue;
    }

    if (info.kind === 'heading') {
      const hTitle = info.text.replace(/^#{1,6}\s+/, '');
      const hasSymInH = /^[■●◆▲▶★◎◩]/.test(hTitle) || /^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|[IVX]{1,4})\.\s/.test(hTitle);
      const isHalfParenH = /^\d{1,2}\)\s/.test(hTitle);
      const isFullParenH = /^\(\d{1,2}\)\s/.test(hTitle);
      const isCircledH = /^[①-⑳]\s/.test(hTitle);
      // Demote mistakenly pre-promoted intro preview summaries ("몇가지를 생각해 보자.\n### 1) ...\n### 2) ...\n## ■ ...")
      if (isHalfParenH && info.level >= 2) {
        let sIdx = i;
        while (sIdx - 1 >= startIdx) {
          const pk = parsedLines[sIdx - 1];
          if (pk.kind === 'blank') { sIdx--; continue; }
          if (pk.kind === 'heading' && /^\d{1,2}\)\s/.test(pk.text.replace(/^#{1,6}\s+/, ''))) { sIdx--; continue; }
          break;
        }
        while (sIdx < i && parsedLines[sIdx].kind === 'blank') sIdx++;
        let eIdx = i;
        while (eIdx + 1 < parsedLines.length) {
          const nk = parsedLines[eIdx + 1];
          if (nk.kind === 'blank') { eIdx++; continue; }
          if (nk.kind === 'heading' && /^\d{1,2}\)\s/.test(nk.text.replace(/^#{1,6}\s+/, ''))) { eIdx++; continue; }
          break;
        }
        while (eIdx > i && parsedLines[eIdx].kind === 'blank') eIdx--;
        let cnt = 0; let cleanOnly = true;
        for (let k = sIdx; k <= eIdx; k++) {
          if (parsedLines[k].kind === 'heading') cnt++;
          else if (parsedLines[k].kind !== 'blank') { cleanOnly = false; break; }
        }
        let prevNb = sIdx - 1;
        while (prevNb >= startIdx && parsedLines[prevNb].kind === 'blank') prevNb--;
        let nextNb = eIdx + 1;
        while (nextNb < parsedLines.length && parsedLines[nextNb].kind === 'blank') nextNb++;
        const pLead = prevNb >= startIdx && isIntroLeadLine(rawLines[prevNb] || '');
        const np = nextNb < parsedLines.length ? parsedLines[nextNb] : null;
        const nMaj = np && (np.kind === 'heading_sym' || np.kind === 'heading_roman' || (np.kind === 'heading' && /#\s+(?:[■●◆▲▶★◎◩]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.)/.test(np.text || '')));
        if (cleanOnly && cnt >= 2 && pLead && nMaj) {
          processedLines.push(hTitle);
          continue;
        }
      }
      const effRank = hasSymInH
        ? Math.min(info.level, 1.5)
        : (isHalfParenH ? 3 : (isFullParenH ? 3.5 : (isCircledH ? 4.5 : info.level)));
      while (headingStack.length > 0 && headingStack[headingStack.length - 1].rank >= effRank) {
        headingStack.pop();
      }
      const parentLvl = headingStack.length > 0 ? headingStack[headingStack.length - 1].level : 0;
      const adjLevel = (isHalfParenH || isFullParenH || isCircledH) && parentLvl >= info.level && parentLvl + 1 <= maxHeadingLevel
        ? parentLvl + 1
        : info.level;
      headingStack.push({ rank: effRank, level: adjLevel, isHalfParen: isHalfParenH });
      indentStack.length = 0;
      hadProseSinceHeading = false;
      if (activeCircledPass && adjLevel <= activeCircledPass.level) {
        activeCircledPass = null;
      }
      processedLines.push(adjLevel !== info.level ? `${'#'.repeat(adjLevel)} ${hTitle}` : info.text);
      continue;
    }

    if (opts.normalizeHierarchy) {
      const allowPromote = !opts.preserveExistingHeadings;
      if (allowPromote && info.kind === 'heading_sym') {
        const titleWithSym = `${info.sym} ${info.title}`;
        const isPrimarySym = info.sym === '●' || info.sym === '■' || (!hasTopLevelSymOrRoman && info.sym === '◩');
        const minLvl = isPrimarySym ? 1 : 2;
        const hLine = pushHeadingRank(isPrimarySym ? 1 : 2, minLvl, titleWithSym);
        activeCircledPass = null;
        processedLines.push(hLine || `${'#'.repeat(minLvl)} ${titleWithSym}`);
        continue;
      }
      if (allowPromote && info.kind === 'heading_roman') {
        const hLine = pushHeadingRank(1, 1, info.title);
        activeCircledPass = null;
        processedLines.push(hLine || `# ${info.title}`);
        continue;
      }
      const canPromoteNumCandidate =
        info.kind === 'heading_num_candidate' && (
          !hasExistingH2 ||
          hasExplicitNumDotHeading ||
          hasOrderedSibling(i, 0) ||
          hasDocHalfParenSub ||
          (info.title || '').replace(/\*\*|__|~~|<\/?u>/gi, '').trim().length <= 42
        );
      const hasImmediateTabChildInSermon =
        !isGeneralDoc &&
        i + 1 < rawLines.length &&
        /^\t+(?:-\s+|\d+[.)]\s+)/.test(rawLines[i + 1]);
      if (allowPromote && canPromoteNumCandidate && !hasImmediateTabChildInSermon) {
        const plainTitle = (info.title || '').replace(/\*\*|__|~~|<\/?u>/gi, '').trim();
        const isOrphanLongNum1 = info.numVal === 1 && plainTitle.length > 42 && !hasOrderedSibling(i, 0);
        if (!isOrphanLongNum1) {
          const hLine = pushHeadingRank(2, 2, `${info.num}. ${info.title}`);
          if (activeCircledPass && headingStack.length > 0 && headingStack[headingStack.length - 1].level <= activeCircledPass.level) {
            activeCircledPass = null;
          }
          processedLines.push(hLine || `## ${info.num}. ${info.title}`);
          continue;
        }
      }
      if (allowPromote && info.kind === 'heading_angle' && maxHeadingLevel >= 5) {
        const hLine = pushHeadingRank(info.headingRank, 5, info.title);
        if (hLine) {
          processedLines.push(hLine);
          continue;
        }
      }
      if (info.kind === 'outline_sub') {
        const isCircledSub = /^[①-⑳]$/.test(info.marker || '') && info.canBeHeading;
        const isHalfParenMarker = info.indent === 0 && /^\d{1,2}\)$/.test(info.marker || '');
        const isCapAlpha = info.indent === 0 && /^[A-Z]\.$/.test(info.marker || '');
        const isAlphaSub = info.indent === 0 && /^[A-Za-z]\.$/.test(info.marker || '');
        const effCanBeHeading =
          info.canBeHeading ||
          (isCapAlpha && hasCapAlphaSeries && info.body.length <= 36 && !/[?!]/.test(info.body) && (info.body.match(/,/g) || []).length < 2);
        const isHalfParenSub = isHalfParenMarker && effCanBeHeading;
        const isFullParenSub = info.indent === 0 && /^\(\d{1,2}\)$/.test(info.marker || '') && effCanBeHeading;
        const fromAiBulletParen = !!(opts.fromAiPass && isFullParenSub && /^\s*[-*+]\s+\(\d{1,2}\)\s/.test(line) && !hasExplicitFullParenHeading);
        const allowFromBullet = (!info.fromBullet && !fromAiBulletParen) || (hasExplicitFullParenHeading && !/[.?!다요죠함음]$/.test(info.body));
        const inActiveSiblingList =
          !isCircledSub &&
          indentStack.some((w) => w <= info.indent) &&
          !((isHalfParenSub || isFullParenSub || isAlphaSub) && headingStack.some((h) => h.level >= 2));

        if (allowPromote && isCapAlpha && capAlphaAsTopLevel && allowFromBullet && effCanBeHeading) {
          headingStack.length = 0;
          indentStack.length = 0;
          activeCircledPass = null;
          headingStack.push({ rank: 1, level: 1 });
          processedLines.push(`# ${info.marker} ${info.body}`);
          continue;
        }

        const isIntroPreviewSummaryAt = () => {
          if (!isHalfParenMarker) return false;
          // Look backward for contiguous 1), 2)... block without intervening prose
          let startRun = i;
          while (startRun - 1 >= startIdx) {
            const pr = parsedLines[startRun - 1];
            if (pr.kind === 'blank') { startRun--; continue; }
            if (pr.kind === 'outline_sub' && /^\d{1,2}\)$/.test(pr.marker || '') && pr.indent === 0) {
              startRun--;
              continue;
            }
            break;
          }
          // Trim leading blank lines from startRun
          while (startRun < i && parsedLines[startRun].kind === 'blank') startRun++;
          let endRun = i;
          while (endRun + 1 < parsedLines.length) {
            const nx = parsedLines[endRun + 1];
            if (nx.kind === 'blank') { endRun++; continue; }
            if (nx.kind === 'outline_sub' && /^\d{1,2}\)$/.test(nx.marker || '') && nx.indent === 0) {
              endRun++;
              continue;
            }
            break;
          }
          while (endRun > i && parsedLines[endRun].kind === 'blank') endRun--;
          let countItems = 0;
          for (let k = startRun; k <= endRun; k++) {
            if (parsedLines[k].kind === 'outline_sub') countItems++;
            else if (parsedLines[k].kind !== 'blank') return false;
          }
          if (countItems < 2) return false;
          // Check immediately before startRun for intro lead OR immediately after endRun for major ■/● heading
          let prevNonBlank = startRun - 1;
          while (prevNonBlank >= startIdx && parsedLines[prevNonBlank].kind === 'blank') prevNonBlank--;
          const hasLead = prevNonBlank >= startIdx && isIntroLeadLine(rawLines[prevNonBlank] || '');
          let nextNonBlank = endRun + 1;
          while (nextNonBlank < parsedLines.length && parsedLines[nextNonBlank].kind === 'blank') nextNonBlank++;
          const np = nextNonBlank < parsedLines.length ? parsedLines[nextNonBlank] : null;
          const followedByMajorH = np && (
            np.kind === 'heading_sym' ||
            np.kind === 'heading_roman' ||
            (np.kind === 'heading' && np.level <= 2 && /[#]\s+(?:[■●◆▲▶★◎◩]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.)/.test(np.text || ''))
          );
          return !!(hasLead && followedByMajorH);
        };

        const nestedUnderHalfParen = isHalfParenSub && headingStack.some((h) => h.isHalfParen);
        const indentedSublistUnderProse = info.indent > 0 && hadProseSinceHeading && !isCircledSub;
        const shouldPromoteToHeading =
          allowPromote &&
          allowFromBullet &&
          effCanBeHeading &&
          !indentedSublistUnderProse &&
          !isIntroPreviewSummaryAt() &&
          !((nestedUnderHalfParen || isFullParenSub) && isContiguousProseListAt(parsedLines, i, null)) &&
          (isCircledSub ? maxHeadingLevel >= 2 : maxHeadingLevel >= 3) &&
          !inActiveSiblingList &&
          (isCircledSub || !hasExistingHeadings || headingStack.length > 0);

        if (shouldPromoteToHeading) {
          let useRank = info.headingRank;
          let useMin = isCircledSub ? 2 : 3;
          if (isCircledSub) {
            const ord = info.marker.charCodeAt(0) - 0x2460 + 1;
            if (activeCircledPass && activeCircledPass.ordinal >= 2 && activeCircledPass.hadProse && ord === 1 && hasFollowingCircledTwo(i)) {
              useRank = activeCircledPass.level + 0.25;
              useMin = Math.min(maxHeadingLevel, activeCircledPass.level + 1);
            }
          }
          const hLine = pushHeadingRank(useRank, useMin, `${info.marker} ${info.body}`, { isHalfParen: isHalfParenSub });
          if (hLine) {
            if (isCircledSub) {
              const ord = info.marker.charCodeAt(0) - 0x2460 + 1;
              const pushedLvl = headingStack[headingStack.length - 1].level;
              if (!activeCircledPass || pushedLvl <= activeCircledPass.level) {
                activeCircledPass = { level: pushedLvl, ordinal: ord, hadProse: false };
              }
            } else if (activeCircledPass && headingStack.length > 0 && headingStack[headingStack.length - 1].level <= activeCircledPass.level) {
              activeCircledPass = null;
            }
            processedLines.push(hLine);
            continue;
          }
        }

        while (indentStack.length > 0 && indentStack[indentStack.length - 1] > info.indent) {
          indentStack.pop();
        }
        if (indentStack.length === 0 || indentStack[indentStack.length - 1] < info.indent) {
          if (info.indent > 0 || indentStack.length === 0) {
            indentStack.push(info.indent);
          }
        }
        const tabDepth = Math.max(0, indentStack.length - 1);
        const tabs = opts.spacesToTabs ? '\t'.repeat(tabDepth) : '  '.repeat(tabDepth);
        if (/^\d{1,2}\)$/.test(info.marker || '')) {
          processedLines.push(`${tabs}${info.marker} ${info.body}`);
        } else if (isGeneralDoc && tabDepth === 0) {
          const prefix = info.marker && info.marker !== '-' ? `${info.marker} ` : '';
          processedLines.push(`${prefix}${info.body}`);
        } else {
          const prefix = info.marker && info.marker !== '-' ? `${info.marker} ` : '';
          processedLines.push(`${tabs}- ${prefix}${info.body}`);
        }
        continue;
      }
      if (info.kind === 'ordered_list' || info.kind === 'heading_num_candidate') {
        while (indentStack.length > 0 && indentStack[indentStack.length - 1] > info.indent) {
          indentStack.pop();
        }
        if (indentStack.length === 0 && /\t/.test(info.leading)) {
          const leadTabs = (info.leading.match(/\t/g) || []).length;
          for (let t = 0; t < leadTabs; t++) indentStack.push(t * 4);
        }
        if (indentStack.length === 0 || indentStack[indentStack.length - 1] < info.indent) {
          if (info.indent > 0 || indentStack.length === 0) {
            indentStack.push(info.indent);
          }
        }
        const tabDepth = Math.max(0, indentStack.length - 1);
        const tabs = opts.spacesToTabs ? '\t'.repeat(tabDepth) : '  '.repeat(tabDepth);
        const hasSibling = hasOrderedSibling(i, info.indent);
        const convertToBullet = !isGeneralDoc && (
          (autoNumStyle === 'to_bullet' && info.indent > 0) ||
          (autoNumStyle === 'smart' && info.numVal === 1 && !hasSibling)
        );
        if (convertToBullet) {
          processedLines.push(`${tabs}- ${info.body}`);
        } else {
          processedLines.push(`${tabs}${info.num}. ${info.body}`);
        }
        continue;
      }
      if (info.kind === 'bullet') {
        while (indentStack.length > 0 && indentStack[indentStack.length - 1] > info.indent) {
          indentStack.pop();
        }
        if (indentStack.length === 0 && /\t/.test(info.leading)) {
          indentStack.push(0);
        }
        if (indentStack.length === 0 || indentStack[indentStack.length - 1] < info.indent) {
          if (info.indent > 0 || indentStack.length === 0) {
            indentStack.push(info.indent);
          }
        }
        const tabDepth = Math.max(0, indentStack.length - 1);
        const tabs = opts.spacesToTabs ? '\t'.repeat(tabDepth) : '  '.repeat(tabDepth);
        let bodyOut = info.body;
        const boldOrPlainHalf = bodyOut.match(/^(?:\*\*(\d{1,2}\))\*\*\s*(.+)|(\*\*)?(\d{1,2}\))\s*(.+))$/);
        if (boldOrPlainHalf && autoNumStyle !== 'to_bullet') {
          const hTok = boldOrPlainHalf[1] || boldOrPlainHalf[4];
          const hRest = boldOrPlainHalf[1] ? boldOrPlainHalf[2] : (boldOrPlainHalf[3] ? `**${boldOrPlainHalf[5]}` : boldOrPlainHalf[5]);
          processedLines.push(`${tabs}${hTok} ${hRest}`);
          continue;
        }
        const boldOrPlainNum = bodyOut.match(/^(?:\*\*(\d{1,2})\.\*\*\s*(.+)|(\*\*)?(\d{1,2})\.\s*(.+))$/);
        if (boldOrPlainNum) {
          const nv = parseInt(boldOrPlainNum[1] || boldOrPlainNum[4], 10);
          const isBoldWrap = !!boldOrPlainNum[3];
          const numRest = boldOrPlainNum[1] ? boldOrPlainNum[2] : (isBoldWrap ? `**${boldOrPlainNum[5]}` : boldOrPlainNum[5]);
          if (nv >= 2 && autoNumStyle !== 'to_bullet') {
            processedLines.push(`${tabs}${nv}. ${numRest}`);
            continue;
          }
          if (nv === 1) {
            let hasSeq2 = false;
            const curW = info.indent;
            for (let k = i + 1; k < Math.min(rawLines.length, i + 80); k++) {
              const rawK = rawLines[k];
              if (!rawK.trim()) continue;
              if (/^#{1,6}\s+/.test(rawK.trim())) break;
              const plK = parsedLines[k];
              if (plK && plK.kind === 'heading') break;
              const kLead = rawK.match(/^[ \t]*/)[0];
              const kW = getIndentWidth(kLead);
              if (kW < curW) break;
              if (kW === curW && /^(?:(?:-\s+|[ㆍ·•]\s*))?(?:\*\*)?2\.\s*/.test(rawK.slice(kLead.length))) {
                hasSeq2 = true;
                break;
              }
            }
            if ((hasSeq2 || isBoldWrap || isGeneralDoc) && autoNumStyle !== 'to_bullet') {
              processedLines.push(`${tabs}1. ${numRest}`);
              continue;
            }
            if (autoNumStyle !== 'keep') {
              bodyOut = numRest;
            }
          }
        }
        if (isGeneralDoc && tabDepth === 0 && (bodyOut.length >= 26 || /[.?!。]["'”’)]*$/.test(bodyOut))) {
          processedLines.push(bodyOut);
        } else {
          processedLines.push(`${tabs}- ${bodyOut}`);
        }
        continue;
      }
    } else if (opts.spacesToTabs && info.kind === 'bullet') {
      const tabDepth = Math.floor(info.indent / 2);
      if (isGeneralDoc && tabDepth === 0) {
        processedLines.push(info.body);
      } else {
        processedLines.push(`${'\t'.repeat(tabDepth)}- ${info.body}`);
      }
      continue;
    }

    // Plain or heading or quote
    if (activeCircledPass) activeCircledPass.hadProse = true;
    if (info.kind === 'plain') {
      indentStack.length = 0;
      hadProseSinceHeading = true;
      // Preserve intentional tab indentation if not list, else trim leading copy-paste clutter spaces
      processedLines.push(info.text);
    } else {
      processedLines.push(line);
    }
  }

  // Third pass: merge broken prose lines if enabled
  let linesAfterMerge = processedLines;
  if (opts.mergeBrokenLines) {
    linesAfterMerge = mergeBrokenLinesPass(processedLines, opts.vaultBasePath || '');
  }

  // Fourth pass: split glued Bible verse/explanation & normalize Bible references
  const verseSplitLines = opts.normalizeBibleRefs
    ? splitAndNormalizeBiblePassagesPass(linesAfterMerge, opts)
    : linesAfterMerge;
  const verseCleanLines = verseSplitLines.map((line) => {
    if (opts.normalizeBibleRefs && !/^\s*(?:```|~~~)/.test(line)) {
      return normalizeBibleRefsInLine(line, !!opts.quoteStandaloneVerses, !!opts.stripVerseBlockquotes);
    }
    return line;
  });

  // Fifth pass: whole-document consistency reconciliation (inspect entire outline & fix parent/sibling inversions)
  let finalLines = reconcileDocumentStructure(verseCleanLines, opts);
  if (opts.fixKoreanSpacing !== false) {
    let inFence = false;
    finalLines = finalLines.map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return fixKoreanSpacingOffline(line);
    });
  }
  if (isGeneralDoc && opts.normalizeBibleRefs !== false) {
    finalLines = padGeneralStandaloneBibleVerses(finalLines);
  }

  // Collapse 3+ consecutive newlines to 2 (1 blank line)
  let joined = finalLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const rawHead = frontmatter || generatedFm;
  const head = applyDocProfileFrontmatter(rawHead, isGeneralDoc, !!opts.useSelectionOnly);
  let outText = joined ? joined + '\n' : '';
  if (head) {
    const cleanHead = head.endsWith('\n') ? head : head + '\n';
    outText = cleanHead + outText;
  }
  // Guarantee 1-click idempotency: converge cleanly across passes (up to 5) whenever Pass-N unwraps/promotes new structure
  const convDepth = opts._convDepth || 0;
  if (!opts.respectAiHeadings && convDepth < 5 && outText !== String(rawText || '')) {
    return refineMarkdownByRules(outText, Object.assign({}, opts, {
      addMissingFrontmatter: false,
      _convDepth: convDepth + 1
    }));
  }
  return outText;
}

function splitLongLineForChunking(line, maxChars) {
  const pieces = [];
  let rem = line;
  while (rem.length > maxChars) {
    const windowStr = rem.slice(0, maxChars);
    // Prefer sentence-ending punctuation with following whitespace, then plain whitespace
    let cut = -1;
    const sentMatches = Array.from(windowStr.matchAll(/[.?!。？！]["'”’)]*\s+/g));
    if (sentMatches.length > 0) {
      const last = sentMatches[sentMatches.length - 1];
      if (last.index + last[0].length >= Math.floor(maxChars * 0.4)) {
        cut = last.index + last[0].length;
      }
    }
    if (cut <= 0) {
      const sp = windowStr.lastIndexOf(' ');
      if (sp >= Math.floor(maxChars * 0.5)) cut = sp + 1;
    }
    if (cut <= 0) cut = maxChars;
    pieces.push(rem.slice(0, cut).trimEnd());
    rem = rem.slice(cut).trimStart();
  }
  if (rem) pieces.push(rem);
  return pieces;
}

function isMajorChunkBoundaryLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  return /^(?:#{1,3}\s+|[#■●◆▲▶★◎◩]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\.\s+|\d{1,2}\.\s+[^\d])/.test(t);
}

function splitIntoChunks(body, maxChars = 11000) {
  const norm = String(body || '').replace(/\r\n/g, '\n');
  if (norm.length <= maxChars) return [norm];

  const blocks = norm.split(/\n{2,}/);
  const chunks = [];
  let cur = [];
  let curLen = 0;

  for (const blk of blocks) {
    if (blk.length > maxChars) {
      if (cur.length) {
        chunks.push(cur.join('\n\n'));
        cur = [];
        curLen = 0;
      }
      const subLines = blk.split('\n').flatMap((sl) => (sl.length > maxChars ? splitLongLineForChunking(sl, maxChars) : [sl]));
      let sub = [];
      let subLen = 0;
      for (const sl of subLines) {
        const preferSplitHere = subLen >= Math.floor(maxChars * 0.55) && isMajorChunkBoundaryLine(sl);
        if ((subLen + sl.length + 1 > maxChars || preferSplitHere) && sub.length > 0) {
          chunks.push(sub.join('\n'));
          sub = [sl];
          subLen = sl.length;
        } else {
          sub.push(sl);
          subLen += sl.length + 1;
        }
      }
      if (sub.length) chunks.push(sub.join('\n'));
      continue;
    }

    const firstBlkLine = blk.split('\n')[0] || '';
    const preferSplitBlock = curLen >= Math.floor(maxChars * 0.55) && isMajorChunkBoundaryLine(firstBlkLine);
    if ((curLen + blk.length + 2 > maxChars || preferSplitBlock) && cur.length > 0) {
      chunks.push(cur.join('\n\n'));
      cur = [blk];
      curLen = blk.length;
    } else {
      cur.push(blk);
      curLen += blk.length + 2;
    }
  }
  if (cur.length) chunks.push(cur.join('\n\n'));
  return chunks;
}

function getHeadingGuideForAi(headingScope = 'h1_h6') {
  if (headingScope === 'h1_h2') {
    return `  1. 내용 흐름상 최상위 **대지(큰 대주제·단원 전환)** 는 반드시 **제목1('# ')부터** 시작하고, **중지(하위 주제)** 는 **제목2('## ')** 로 배치하십시오. (소지 이하 세부 항목은 탭 '\\t- ' 목록으로 정리, 원본에 없는 숫자 새로 붙이기 금지)`;
  }
  if (headingScope === 'h1_h3') {
    return `  1. 내용 흐름상 계층은 반드시 아래처럼 **제목1('# ')부터** 내려가십시오 (세부 항목은 탭 '\\t- ' 목록):
     - **제목1('# ')**: 최상위 **대지** (큰 주제·대단원)
     - **제목2('## ')**: **중지** (대지 아래 중간 논지)
     - **제목3('### ')**: **소지** (중지 아래 작은 주제)`;
  }
  return `  1. 문서 전체 내용을 파악해 반드시 **제목1('# ')부터** 논리적 깊이에 따라 아래 순서로 계층을 구성하십시오 (원본에 없는 번호 '1.', '2.'를 새로 창작하지 마십시오):
     - **제목1('# ')**: **대지** (문서 내 가장 큰 주제 전환·대단원. 서론/본론/결론 또는 큰 대지 자체)
     - **제목2('## ')**: **중지** (대지 아래에 속한 중간 논지)
     - **제목3('### ')**: **소지** (중지 아래에 속한 작은 주제)
     - **제목4~6('#### ' ~ '###### ')**: **세부 소주제·보충·참고 소제목** (단순 문장·설명은 제목으로 올리지 말 것)`;
}

function detectRecommendedDocProfile(rawText) {
  const { body } = splitFrontmatter(String(rawText || ''));
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let dashCount = 0;
  let proseCount = 0;
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (/^-\s+/.test(l)) dashCount++;
    else if (t.length >= 40 && /(?:다|요|죠|까|네|라)\.$/.test(t) && !/^#/.test(t) && !/^\d+[.)]\s/.test(t)) {
      proseCount++;
    }
  }
  return (proseCount >= 6 && (dashCount <= 1 || proseCount >= dashCount * 2)) ? 'general' : 'sermon';
}

function buildGlobalOutlinePlanPrompt(fullBody, headingScope = 'h1_h6', customNote = '', docProfile = 'sermon') {
  const maxSrc = 120000;
  let bodyForPlan = fullBody;
  if (fullBody.length > maxSrc) {
    const third = Math.floor(maxSrc / 3);
    bodyForPlan = `${fullBody.slice(0, third)}\n\n... [중간 일부 생략] ...\n\n${fullBody.slice(Math.floor(fullBody.length / 2) - Math.floor(third / 2), Math.floor(fullBody.length / 2) + Math.floor(third / 2))}\n\n... [후반 계속] ...\n\n${fullBody.slice(-third)}`;
  }

  const customPriority = customNote
    ? `\n🚨 [최우선 사용자 직접 지시 — 아래 일반 설계 규칙보다 항상 우선하여 적용하십시오]\n${customNote}\n`
    : '';

  return `당신은 설교·성경연구 노트 전체 구조를 설계하는 편집장입니다.
아래 노트 **전체 내용을 처음부터 끝까지 통독하며 신학적·논리적 흐름과 주제 포함 관계를 파악**한 뒤, 본문 전체에 일관되게 적용할 **전체 목차 계층 설계도(# ~ ######)** 만 작성하십시오.${customPriority}
[설계 핵심 규칙]
${getHeadingGuideForAi(headingScope)}
2. **제목1('# ')부터 시작 & 하위 제목까지 문서 전체 일관성 (가장 중요)**:
   - 문서 맨 첫 줄의 전체 파일 제목(예: '# 성경의 선용과 악용')은 '# ' 제목1에 두지 말고 일반 굵은 제목('**성경의 선용과 악용**')으로 내려 둔 뒤, 본문의 큰 대단원('■ ...', '● ...', 'Ⅰ. ...')부터 **반드시 '# '(제목1)** → 중지 '## ' → 소지 '### ' 순서로 시작하십시오. 문서 전체를 제목2('## ') 몇 개로만 시작하고 그 아래 소제목('1. ...', '1) ...', '① ...')을 빠뜨리는 불완전한 설계를 금지합니다!
   - 문서 전체에서 **같은 기호/체계('■ ...', '● ...', '1. ...', '1) ...')** 를 쓰는 형제 항목은 문장이 길거나 '~다.'로 끝나더라도(들여쓴 '\t1.' 목록과 맨 앞 대지 앞 서론 요약 '1)~3)' 제외) 문서 처음부터 끝까지 빠짐없이 같은 '#' 제목 등급으로 통일해 계층에 넣으십시오.
3. **출력 형식**:
   - 인사말·설명·코드블록(\`\`\`) 없이, 문서 등장 순서대로 **'# ~ ######' 제목 줄만** 1줄에 하나씩 출력하십시오.${docProfile === 'general' ? '\n4. [일반 문서 양식]: 일반 원고·단행본이므로 서술 문단에 마인드맵용 \'- \'(대지 불릿)를 붙이지 말고 평문 문단으로 두십시오.' : ''}${customNote ? `\n${docProfile === 'general' ? '5' : '4'}. [다시 강조 — 사용자 추가 지시 최우선]: ${customNote}` : ''}

[전체 노트 원문]
${bodyForPlan}`;
}

function buildAiPrompt(mode, chunkText, customNote, headingScope = 'h1_h6', autoNumberedStyle = 'smart', contextObj = null, docProfile = 'sermon') {
  const autoNumNote = autoNumberedStyle === 'to_bullet'
    ? `4. 옵시디언 자동 목록 기능 등으로 들여쓰기된 '1. / 2.' 숫자 목록은 문맥상 반드시 번호가 필요한 대지 제목이 아니면 모두 '- ' 일반 목록으로 바꾸고, 원본에 숫자가 없던 곳에 임의로 새 번호를 붙이지 마십시오.`
    : `4. 원본에 숫자가 없는 제목이나 목록에 임의로 '1.', '2.', '①' 등 새 번호를 매핑하지 마십시오. 반대로 옵시디언 자동 목록 완성 때문에 잘못 들어간 단독 '1.'이나 '- 1.' 중복 번호는 '- ' 일반 목록으로 복원하십시오.`;

  const isGen = docProfile === 'general';
  const customTop = customNote
    ? `\n🚨 [최우선 사용자 추가 지시 — 아래 일반 규칙보다 항상 우선 적용! 절대 무시하지 마십시오]\n${customNote}\n`
    : '';
  const profileNote = isGen
    ? `\n\n[문서 양식: 📄 일반 문서 (목사님 원고 · 단행본 · 강의안)]
- 이 문서는 개인 설교 마인드맵이 아닌 **일반 원고/단행본**입니다.
- **절대 문단 앞에 마인드맵용 '- '(대지 기호)나 '\\t- ' 탭 목록을 새로 붙이지 마십시오.** (원본 서술 문장에 붙은 '- ', '✓ '는 일반 평문 단락으로 푸십시오.)
- 본문 설명·예화·인용은 문맥에 맞는 자연스러운 일반 평문 단락으로 두고, **제목(#~######)과 제목 아래 붙어 나온 설명 문장·한 줄에 연달아 붙은 '5. ... 6. ...' 번호 항목은 반드시 줄바꿈으로 분리**하십시오.
- 맨 위 문서 전체 제목 1줄('# 성경의 선용과 악용' 등)은 '**...**' 굵은 제목으로 내리고, 본문의 큰 대지('■ ...', '● ...')부터 **제목1('# ')부터** 일관되게 계층을 잡으며, 줄바꿈 앞의 col-0 \`1. 2. 3.\`·\`1) 2) 3)\` 번호·글머리 기호도 문장 길이와 무관하게 하이어라키를 통일하여 모두 제목 서식(\`## 1.\`, \`### 1)\` 등)으로 올리십시오(맨 앞 대지 앞 서론 미리보기 '1)~3)'과 들여쓴 '\t1.' 제외).
- 성경 구절(\`(장:절) 말씀...\`)만 독립된 줄로 쓸 때는 구절 위아래에 빈 줄을 1줄씩 두십시오.`
    : '';

  const commonRules = `당신은 목회자/신학자의 옵시디언 설교·성경연구 노트 편집 도우미입니다.
아래 원문 텍스트를 손실 없이 다듬어 마크다운으로만 출력하십시오.${customTop}

[절대 보존 규칙]
1. 내용을 요약하거나 삭제·축약·창작하지 마십시오. 원문의 모든 논지, 예화, 구절, 신학 용어를 빠짐없이 유지하십시오.
2. 기존에 들어있는 옵시디언 마크업(==강조==, %%shade:...%%, [대괄호 강조], [[내부링크]], <font ...>, <u>...</u>)은 절대 훼손하지 마십시오.
3. 성경 구절 인용(기본 **개역한글** 기준 — '가라사대', '~느뇨', '~찌어다', '말찌로다' 등 옛 어투를 임의로 개역개정·현대어로 바꾸지 마십시오), 한자(漢字), 헬라어(악센트·숨표 포함), 히브리어(니쿠드 포함), 영어 인용은 원형 그대로 보존하십시오.
${autoNumNote}
5. 인사말이나 코드블록(\`\`\`) 없이 정리된 마크다운 본문만 출력하십시오.${customNote ? `\n6. [최우선 재확인] 사용자 추가 지시: ${customNote}` : ''}`;

  const headingGuide = getHeadingGuideForAi(headingScope);

  const globalPlanBlock = contextObj && contextObj.globalOutlinePlan
    ? `\n[문서 전체 통독 기반 하이어라키 설계도 — 반드시 이 계층 기준(#~######)을 엄수하십시오]\n${contextObj.globalOutlinePlan}\n`
    : '';
  const prevContextBlock = contextObj && contextObj.prevTail
    ? `\n[직전 구간의 마무리 문맥 (이어지는 계층 참고용 — 출력에 중복 포함하지 마십시오)]\n${contextObj.prevTail}\n`
    : '';

  const modeLead = mode === 'ai_struct'
    ? `[이번 작업: 전체 편집 (전체 문맥 기반 AI 맞춤법·오타 교정 + 제목1('# ')부터 일관된 하이어라키 구조화)]
- 먼저 내용 전체의 흐름(대지 '# ' → 중지 '## ' → 소지 '### ' → 세부 '####'~'######')을 파악하고, 붙은 띄어쓰기('대한정확한이해를하고' → '대한 정확한 이해를 하고')·복붙/STT 오타('말음'→'마음', '받향'→'방향', '아리스다교'→'아리스다고')·성경 장절 오기('행 18:1_4' → '행 18:1-4')·HTML 잔재(&#8228;→·)·끊긴 줄바꿈과 문단을 깔끔히 교정·구조화하십시오:`
    : `[이번 작업: AI 맞춤법, 구조화 정리]
- 전체 내용의 논리 흐름(대지 '# ' → 중지 '## ' → 소지 '### ' → 세부 '####'~'######')을 파악해 제목1('# ')부터 일관되게 계층을 잡으면서, 붙은 띄어쓰기·복붙 오타·끊긴 줄바꿈과 문단을 교정·구조화하십시오:`;

  const outlineAndIndentRules = isGen
    ? `  3. **제목·번호 분리 및 문단 줄바꿈 정리 (매우 중요)**:
     - **제목/소제목 뒤에 설명 문장이나 성구 인용이 바로 한 줄에 붙어 있으면** (예: \`**3) ... 드러냄** 하나님 불의하다?\`, \`**1. 성령을 받을 때...** "기록된바..."\`) **반드시 줄바꿈으로 제목과 아래 본문을 분리**하십시오.
     - **한 줄 안에 다음 번호가 이어붙은 경우** (예: \`**5. ... 같다.** **6. 교회를...**\`, \`...연약함 **3. 하나님이...**\`) 반드시 각 번호마다 새 문단으로 나누십시오.
     - **\`1. 2. 3.\`·\`1) 2) 3)\` 글머리 통일 승격**: 들여쓰기 없는 \`1. / 2. / 3.\`, \`1) / 2) / 3)\` 번호 항목은 길이나 서술형('~다.') 여부에 상관없이 문서 전체 하이어라키를 통일하여 모두 제목 서식(\`## 1.\`, \`### 1)\` 등)으로 승격시키십시오(맨 앞 대지 앞 서론 요약 '1)~3)'·들여쓴 '\\t1.' 제외).
  4. **성경 구절 정규화 및 설명 분리 (매우 중요)**:
     - \`"말씀..."(요 18:1-11).\`처럼 본문 뒤에 장절이 붙은 독립 성경 인용은 \`(요 18:1-11) 말씀...\` 형태로 앞장절 표기로 통일하십시오(단, \`예수님은 "너희가..."(막 12:24)라고 하셨다.\`처럼 문장 서술어에 직접 연결된 인용은 문장 안에 유지).
     - **성경 구절 줄과 구절 앞/뒤에 붙은 설명 문구·다른 성구 인용은 절대 같은 줄에 붙여 두지 말고 반드시 줄바꿈으로 분리**하고, **독립된 성경 구절 위·아래에는 빈 줄을 1줄씩 두십시오.** 원문에 없던 '>' 인용 기호는 새로 붙이지 말고 구절 괄호 뒤에는 띄어쓰기 1칸을 둡니다.`
    : `  3. **번호·대지 기호 중복, \`-.\` 기호 및 공백 누락 방지 (매우 중요)**:
     - '1) 제목', '2) 제목', '1. 제목', '2. 제목' 앞에 **절대 '- '를 붙이지 마십시오** ('- 1) ...' ❌ → '1) ...' 또는 '\\t1) ...' ⭕, 제목이면 '## 1) ...'). '- 1)'로 쓰면 뷰어에서 '✓ 1)'처럼 대지 기호와 번호가 겹쳐 나옵니다.
     - 반대로 사용자가 직접 지정한 \`✓ 1. ...\`, \`✓ 1) ...\`(숫자 대지 기호) 줄은 '✓ '를 지우거나 제목(#)으로 바꾸지 말고 원형 그대로 유지하십시오.
     - **제목과 아래 문장이 한 줄에 붙어 있거나 한 줄 중간에 다음 번호(\`5. ... 6. ...\`)가 붙어 있으면 반드시 줄바꿈으로 분리**하십시오.
     - \`-. 텍스트\` 형태의 한글 문서 목록은 일반 \`- 텍스트\` 목록으로 정규화하고, 한 줄 중간에 \` -. \`로 이어붙은 항목(\`...지냈다 -. 초기 40년간은...\`)은 반드시 새 줄 \`- \`로 분리하십시오.
     - '■제목', '1.성경', '1)파라오'처럼 기호·번호 뒤 공백이 빠진 경우 반드시 공백 1칸('■ 제목', '1. 성경', '1) 파라오')을 넣으십시오.
  4. **하위 내용 들여쓰기 종속 규칙 (매우 중요)**:
     - '1) ...', '2) ...' 또는 '1. ...', '2. ...' (제목#이 아닌 번호 항목) 아래에 오는 설명 문장·인용구(“...”)**·성경 구절·하위 '①·②' 항목은 그 번호의 하위 내용이므로 **반드시 '\\t'(탭) 한 단계 이상 더 들여쓴 '- ' 목록('\\t- ...')으로 종속**시키십시오. 번호와 같은 0단계 줄(뷰어에서 '✓' 대지 줄)로 두지 마십시오!
     - 만약 앞 문장(예: '여기에서 우리는 몇가지를 생각해 보자.')이 뒤따르는 '1), 2), 3)...' 전체를 여는 도입 문장이라면, 도입 문장을 0단계로 두고 '1) ~' 항목들을 '\\t1) ~'로 1단계 들여쓰고, 그 아래 설명/인용은 '\\t\\t- '로 2단계 들여쓰십시오.
  5. **동일 기호 = 동일 제목(#) 및 번호 체계 문서 전체 일관성 (매우 중요)**:
     - 문서 전체에서 같은 기호('■ ...', '● ...', '◆ ...', '◩ ...')가 하나라도 제목1('# ')이면 나머지 모든 같은 기호 형제도 똑같이 '# ...'로 통일하고, 같은 대지 안의 '1., 2., ... 6., 7.' 형제도 일부만 '## 6.'이 되고 나머지가 평문으로 남지 않게 통일하십시오.
     - 문서 상단에서 \`(1) ...\`, \`(2) ...\`, \`(3) ...\`이나 \`A. ...\`, \`B. ...\`, \`a. ...\`이 각각 \`###\`, \`####\`, \`#####\` 제목으로 올라갔다면, 문서 하단 다른 대지(\`## 2.\`) 아래에 \`- (1) ...\`, \`- (2) ...\`처럼 불릿이 잘못 붙어 있더라도 절대 본문 목록으로 두지 말고 똑같이 \`### (1) ...\`, \`### (2) ...\` 제목으로 통일하십시오.
     - **원문자(①, ②, ③...) 제목 승격**: \`①, ②, ③...\` 원문자 숫자는 본문이나 일반 목록(\`- ①\`)으로 두지 말고, 바로 위에 있는 상위 제목(\`#\`, \`##\`, \`###\` 등)을 찾아 반드시 그 한 단계 아래 제목(\`## ①\`, \`### ①\`, \`#### ①\` 등)으로 승격시키십시오.
     - 상위 번호(예: ⑪)가 목록인데 하위 항목(가., 나.)만 제목(####)으로 뒤집히지 않게 일관성을 유지하십시오.
  6. **성경 구절 정규화 및 설명 분리 (매우 중요)**:
     - \`"말씀..."(창 1:1).\`처럼 뒤에 장절이 붙은 독립 성경 인용은 \`(창 1:1) 말씀...\`(목록 내부라면 \`\\t- (창 1:1) 말씀...\`) 앞장절 표기로 통일하십시오(단, \`...라고 하셨다.\`처럼 문장 서술어에 직접 붙는 인용은 문장 내 유지).
     - **성경 구절과 설명 문구가 같은 줄에 붙어 있으면 반드시 줄바꿈으로 분리**하고, 원문에 없던 '>' 인용 기호를 절대 새로 붙이지 마십시오. 구절 괄호 뒤에는 띄어쓰기 1칸을 둡니다.`;

  return `${commonRules}${profileNote}
${globalPlanBlock}${prevContextBlock}
${modeLead}
${headingGuide}
  2. **끊긴 줄바꿈·어색한 빈 줄(\\n\\n) 연결 및 밑줄 변환 (매우 중요)**:
     - PDF·HWP·DOCX 변환 때문에 **한 문장이나 한 성경 본문 인용, \`<u>...</u>\` / \`[...]{.underline}\` / \`*\*...**\`, 부사·관형어·연결어미 중간이 줄바꿈이나 빈 줄(\\n\\n)로 토막나 있으면** (예: \`(잠 1:10-19) (10) ... (11) 그들이\\n\\n네게 말하기를 ...\`, \`시간을 소중히\\n\\n여길 수 있다.\`, \`그리스도 앞에서 서야\\n\\n한다.\`, \`...보면 그\\n\\n시간이 ...\`, \`*\*... 제 삼\\n\\n일에 살아나야...\*\*\`), **원본의 어색한 줄바꿈과 빈 줄을 그대로 두지 말고 문장·구절이 끝날 때까지 띄어쓰기 1칸으로 자연스럽게 한 문장·한 인용 문단으로 이어 붙이십시오.**
     - Pandoc 밑줄(\`[텍스트]{.underline}\`)은 반드시 옵시디언 HTML 밑줄 태그인 \`<u>텍스트</u>\` 형태로 유지·변환하고, \`{.underline}\` 문법을 그대로 남기지 마십시오.
     - HTML 문단·줄바꿈 태그(\`<p>\`, \`</p>\`, \`<br>\`)는 표(\`| ... |\`) 내부의 \`<br>\`을 제외하고 실제 줄바꿈/문단 나누기로 변환한 뒤 태그 문자열은 모두 제거하고, 해당 줄을 제목·목록·본문 서식에 맞게 정리하십시오(단, \`<u>...</u>\`·\`<font ...>\` 서식 태그는 유지).
${outlineAndIndentRules}
${customNote ? `\n🚨 [최종 확인 — 사용자 추가 지시 최우선 적용]: ${customNote}` : ''}

[현재 편집할 구간]
${chunkText}`;
}

class SermonMdRefineModal extends Modal {
  constructor(app, plugin, targetContext) {
    super(app);
    this.plugin = plugin;
    this.ctx = targetContext; // { file, editor, selectionText, fullText }
    this.mode = 'ai_struct';
    this.opts = {
      docProfile: plugin.settings.docProfile || 'sermon',
      headingLevelScope: plugin.settings.headingLevelScope || 'h1_h6',
      autoNumberedStyle: plugin.settings.autoNumberedStyle || 'smart',
      mergeBrokenLines: !!plugin.settings.mergeBrokenLines,
      normalizeHierarchy: !!plugin.settings.normalizeHierarchy,
      spacesToTabs: !!plugin.settings.spacesToTabs,
      normalizeBibleRefs: !!plugin.settings.normalizeBibleRefs,
      quoteStandaloneVerses: !!plugin.settings.quoteStandaloneVerses,
      stripVerseBlockquotes: !!plugin.settings.stripVerseBlockquotes,
      fixKoreanSpacing: plugin.settings.fixKoreanSpacing !== false,
      addMissingFrontmatter: !!plugin.settings.addMissingFrontmatter,
      useGeminiAi: !!plugin.settings.useGeminiAi,
      useSelectionOnly: !!(targetContext.selectionText && targetContext.selectionText.trim().length > 0)
    };
    this.isBusy = false;
    this.abortController = null;
  }

  onOpen() {
    const { contentEl, modalEl } = this;
    modalEl.addClass('smr-refine-modal');
    contentEl.empty();

    contentEl.createEl('h2', { cls: 'smr-modal-title', text: '✨ 노트 서식 다듬기 (HWP · DOCX · 복붙 정리)' });

    const targetDesc = this.opts.useSelectionOnly
      ? `대상: ${this.ctx.file.basename} (선택 영역 ${this.ctx.selectionText.length.toLocaleString()}자)`
      : `대상: ${this.ctx.file.basename} (전체 ${this.ctx.fullText.length.toLocaleString()}자)`;
    contentEl.createDiv({ cls: 'smr-target-badge', text: targetDesc });

    // Document profile selector (내 설교문 양식 vs 일반 문서/원고)
    const profileGroup = contentEl.createDiv({ cls: 'smr-profile-group' });
    const profiles = [
      { id: 'sermon', title: '📝 내 설교문 양식', sub: 'V 대지 기호·\\t 마인드맵 계층 · 설교 개요 중심' },
      { id: 'general', title: '📄 일반 문서 (목사님 원고 · 단행본)', sub: 'V 대지 기호 제거 · 평문/원본 서식 · 제목(#)·줄바꿈 정리' }
    ];
    const profileBtns = [];
    const hintBar = contentEl.createDiv({ cls: 'smr-profile-hint' });
    const hintText = hintBar.createSpan({ text: '💡 서술형 일반 원고에 가까워 [📄 일반 문서] 양식을 추천합니다.' });
    const hintBtn = hintBar.createEl('button', { cls: 'smr-profile-hint-btn', type: 'button', text: '일반 문서로 전환' });

    const srcForHint = this.opts.useSelectionOnly && this.ctx.selectionText ? this.ctx.selectionText : this.ctx.fullText;
    const recProfile = detectRecommendedDocProfile(srcForHint);
    const syncProfileUi = () => {
      profileBtns.forEach((b, idx) => b.toggleClass('is-active', profiles[idx].id === this.opts.docProfile));
      hintBar.style.display = (this.opts.docProfile === 'sermon' && recProfile === 'general') ? 'flex' : 'none';
    };
    for (const p of profiles) {
      const btn = profileGroup.createEl('button', { cls: 'smr-profile-btn', type: 'button' });
      btn.createDiv({ cls: 'smr-mode-title', text: p.title });
      btn.createDiv({ cls: 'smr-profile-sub', text: p.sub });
      btn.onclick = () => {
        this.opts.docProfile = p.id;
        syncProfileUi();
      };
      profileBtns.push(btn);
    }
    hintBtn.onclick = () => {
      this.opts.docProfile = 'general';
      syncProfileUi();
    };
    syncProfileUi();

    // Rule options box
    const optBox = contentEl.createDiv({ cls: 'smr-options-box' });
    let customRow = null;
    const syncAiNoteRow = () => {
      if (customRow) customRow.style.display = this.opts.useGeminiAi ? 'block' : 'none';
    };
    const addOpt = (key, labelText, onToggle = null) => {
      const lbl = optBox.createEl('label', { cls: 'smr-opt-label' });
      const cb = lbl.createEl('input', { type: 'checkbox' });
      cb.checked = !!this.opts[key];
      cb.onchange = () => {
        this.opts[key] = cb.checked;
        if (onToggle) onToggle(cb.checked);
      };
      lbl.createSpan({ text: labelText });
    };
    addOpt('mergeBrokenLines', '어색한 중간 줄바꿈 잇기');
    addOpt('normalizeHierarchy', '개요(1./①/가./•) → 제목·목록화');
    addOpt('spacesToTabs', '목록 들여쓰기 탭(\\t) 통일 (마인드맵)');
    addOpt('normalizeBibleRefs', '성경 구절 표기 정규화 (창 1:1)');
    addOpt('stripVerseBlockquotes', '성구 줄 앞 > 인용구 제거');
    addOpt('fixKoreanSpacing', '한국어 띄어쓰기 자동 보정 (AI 없이)');
    addOpt('addMissingFrontmatter', '상단 강사/장소 → YAML 머리말');
    if (this.ctx.selectionText) addOpt('useSelectionOnly', '드래그로 선택한 영역만 다듬기');
    addOpt('useGeminiAi', '🤖 Gemini AI 맞춤법·구조화 함께 실행 (선택)', syncAiNoteRow);
    optBox.style.display = 'grid';

    const scopeWrap = contentEl.createDiv({ cls: 'smr-opt-select-row' });
    scopeWrap.createSpan({ text: '제목 적용 깊이:' });
    const scopeSel = scopeWrap.createEl('select', { cls: 'smr-opt-select' });
    [
      ['h1_h6', '제목 1~6 전체 (# ~ ######)'],
      ['h1_h3', '제목 1~3 + 탭 목록 (# ~ ###)'],
      ['h1_h2', '제목 1~2 + 탭 목록 (# ~ ##)']
    ].forEach(([val, label]) => {
      const o = scopeSel.createEl('option', { value: val, text: label });
      if (this.opts.headingLevelScope === val) o.selected = true;
    });
    scopeSel.onchange = () => {
      this.opts.headingLevelScope = scopeSel.value;
    };
    scopeWrap.style.display = 'flex';

    const numWrap = contentEl.createDiv({ cls: 'smr-opt-select-row' });
    numWrap.createSpan({ text: '자동 숫자(1.) 처리:' });
    const numSel = numWrap.createEl('select', { cls: 'smr-opt-select' });
    [
      ['smart', '단독·중복 "1."만 "- "로 정리 (연속 번호 유지)'],
      ['to_bullet', '들여쓰기 숫자목록(1., 2.) 전부 "- " 변환'],
      ['keep', '숫자 목록 그대로 유지 (들여쓰기만 정리)']
    ].forEach(([val, label]) => {
      const o = numSel.createEl('option', { value: val, text: label });
      if (this.opts.autoNumberedStyle === val) o.selected = true;
    });
    numSel.onchange = () => {
      this.opts.autoNumberedStyle = numSel.value;
    };
    numWrap.style.display = 'flex';

    // Custom AI note (shown when Gemini AI option is checked)
    customRow = contentEl.createDiv({ cls: 'smr-custom-note-row' });
    const customInput = customRow.createEl('input', {
      cls: 'smr-custom-note-input',
      type: 'text',
      placeholder: 'AI 추가 지시 (선택, 예: 서론/본론 1,2,3으로 나눠줘 / 한문 병기 유지)'
    });
    customInput.value = this.plugin.settings.customPromptNote || '';
    syncAiNoteRow();

    const getSourceText = () => (this.opts.useSelectionOnly && this.ctx.selectionText ? this.ctx.selectionText : this.ctx.fullText);

    // Status + Footer execute/apply buttons (no preview needed)
    const statusLine = contentEl.createDiv({ cls: 'smr-status-line', text: '원하는 문서 양식과 옵션을 확인한 뒤 아래 적용 버튼을 누르면 즉시 노트를 정리합니다.' });
    const footer = contentEl.createDiv({ cls: 'smr-footer-row' });
    const stopBtn = footer.createEl('button', { text: '중단' });
    stopBtn.style.display = 'none';
    const saveNewBtn = footer.createEl('button', { text: '📄 새 노트로 저장 (_정리본)' });
    const applyBtn = footer.createEl('button', { cls: 'smr-btn-primary', text: '✅ 현재 노트에 적용 (Ctrl+Z 되돌리기 가능)' });

    const setBusy = (busy) => {
      this.isBusy = busy;
      stopBtn.style.display = busy ? 'inline-block' : 'none';
      saveNewBtn.disabled = busy;
      applyBtn.disabled = busy;
    };

    stopBtn.onclick = () => {
      if (this.abortController) this.abortController.abort();
    };

    const runDirectRefine = async () => {
      const src = getSourceText();
      if (this.opts.useGeminiAi) {
        this.plugin.settings.customPromptNote = customInput.value.trim();
        await this.plugin.saveSettings();
      }

      const ruleRunOpts = Object.assign({}, this.opts, {
        vaultBasePath: this.app?.vault?.adapter?.basePath || ''
      });

      if (!this.opts.useGeminiAi) {
        statusLine.setText('⚡ 기존 규칙 로직으로 즉시 정리 중...');
        return refineMarkdownByRules(src, ruleRunOpts);
      }

      const keys = this.plugin.collectGeminiKeys();
      if (!keys.length) {
        statusLine.setText('⚡ Gemini API 키가 없어 규칙 정리(줄바꿈·계층·성구)를 실행합니다...');
        return refineMarkdownByRules(src, ruleRunOpts);
      }

      this.abortController = new AbortController();
      return this.plugin.refineWithGemini(
        src,
        this.mode,
        customInput.value.trim(),
        (msg) => statusLine.setText(msg),
        this.abortController.signal,
        this.opts.headingLevelScope,
        this.opts.autoNumberedStyle,
        this.opts
      );
    };

    applyBtn.onclick = async () => {
      setBusy(true);
      try {
        const finalText = await runDirectRefine();
        if (!finalText) return;
        if (this.plugin.settings.keepBackupOnOverwrite && !this.opts.useSelectionOnly) {
          await this.plugin.createBackupCopy(this.ctx.file, this.ctx.fullText);
        }
        if (this.opts.useSelectionOnly && this.ctx.selectionText && this.ctx.editor) {
          this.ctx.editor.replaceSelection(finalText);
        } else if (this.ctx.editor) {
          const fullEnd = {
            line: this.ctx.editor.lastLine(),
            ch: this.ctx.editor.getLine(this.ctx.editor.lastLine()).length
          };
          this.ctx.editor.replaceRange(finalText, { line: 0, ch: 0 }, fullEnd);
        } else {
          await this.app.vault.modify(this.ctx.file, finalText);
        }
        new Notice('✅ 노트가 정리되었습니다. (Ctrl+Z로 되돌리기 가능)');
        this.close();
      } catch (err) {
        if (err && err.name === 'AbortError') {
          statusLine.setText('⏹ 사용자에 의해 중단되었습니다.');
        } else {
          statusLine.setText(`❌ 오류: ${err.message || err}`);
          new Notice(`적용 실패: ${err.message || err}`, 6000);
        }
      } finally {
        setBusy(false);
      }
    };

    saveNewBtn.onclick = async () => {
      setBusy(true);
      try {
        const finalText = await runDirectRefine();
        if (!finalText) return;
        const parent = this.ctx.file.parent && this.ctx.file.parent.path !== '/' ? `${this.ctx.file.parent.path}/` : '';
        let newPath = `${parent}${this.ctx.file.basename}_정리본.md`;
        let n = 2;
        while (await this.app.vault.adapter.exists(newPath)) {
          newPath = `${parent}${this.ctx.file.basename}_정리본_${n++}.md`;
        }
        const created = await this.app.vault.create(newPath, finalText);
        await this.app.workspace.getLeaf(true).openFile(created);
        new Notice(`📄 새 노트로 저장되었습니다: ${created.basename}`);
        this.close();
      } catch (err) {
        if (err && err.name === 'AbortError') {
          statusLine.setText('⏹ 사용자에 의해 중단되었습니다.');
        } else {
          statusLine.setText(`❌ 오류: ${err.message || err}`);
          new Notice(`새 노트 저장 실패: ${err.message || err}`, 6000);
        }
      } finally {
        setBusy(false);
      }
    };
  }

  onClose() {
    if (this.abortController) this.abortController.abort();
    this.contentEl.empty();
  }
}

class SermonMdRefinerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    containerEl.createEl('h2', { text: '노트 서식 다듬기 설정' });

    new Setting(containerEl)
      .setName('기본 문서 양식')
      .setDesc('내 설교문 양식(V 대지 기호·마인드맵 계층) 또는 일반 문서(V 제거·평문·개요 제목 유지)를 선택합니다.')
      .addDropdown((d) => d
        .addOption('sermon', '📝 내 설교문 양식 (V·마인드맵)')
        .addOption('general', '📄 일반 문서 (목사님 원고·단행본)')
        .setValue(s.docProfile || 'sermon')
        .onChange(async (v) => { s.docProfile = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('기본 제목 계층 범위 (H1~H6)')
      .setDesc('노트 개요를 마크다운 제목(# ~ ######) 몇 단계까지 변환할지 설정합니다. (heading-colors.css 색상과 자동 연동)')
      .addDropdown((d) => d
        .addOption('h1_h6', '제목 1~6 전체 (# ~ ######)')
        .addOption('h1_h3', '제목 1~3 + 탭 목록 (# ~ ###)')
        .addOption('h1_h2', '제목 1~2 + 탭 목록 (# ~ ##)')
        .setValue(s.headingLevelScope || 'h1_h6')
        .onChange(async (v) => { s.headingLevelScope = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('옵시디언 자동 완성 숫자(1.) 기본 정리 방식')
      .setDesc('편집 중 자동 생성된 단독 "1."이나 "- 1." 중복 숫자를 일반 목록("- ")으로 되돌리는 방식입니다.')
      .addDropdown((d) => d
        .addOption('smart', '단독·중복 "1."만 "- "로 정리 (연속 번호 유지)')
        .addOption('to_bullet', '들여쓰기 숫자목록(1., 2.) 전부 "- " 변환')
        .addOption('keep', '숫자 목록 그대로 유지')
        .setValue(s.autoNumberedStyle || 'smart')
        .onChange(async (v) => { s.autoNumberedStyle = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('성구 줄 앞 불필요한 인용(>) 기본 제거')
      .setDesc('켜면 >(창 1:1) 처럼 성구 줄 앞에 붙은 > 인용구를 일반 성구 줄로 되돌립니다. (기본은 새 > 추가 안 함)')
      .addToggle((t) => t.setValue(!!s.stripVerseBlockquotes).onChange(async (v) => {
        s.stripVerseBlockquotes = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('덮어쓰기 전 원본 백업 노트 생성')
      .setDesc('켜면 [현재 노트에 적용] 시 같은 폴더에 "_원본백업" 파일을 먼저 남겨둡니다.')
      .addToggle((t) => t.setValue(!!s.keepBackupOnOverwrite).onChange(async (v) => {
        s.keepBackupOnOverwrite = v;
        await this.plugin.saveSettings();
      }));

    containerEl.createEl('h3', { text: 'AI 정리 (Gemini API)' });

    new Setting(containerEl)
      .setName('기본적으로 Gemini AI 정리 사용')
      .setDesc('끄면(권장) 기존의 빠른 로컬 규칙 로직으로 즉시 정리하고, 정리 창에서 "🤖 Gemini AI 함께 실행"을 체크했을 때만 AI를 호출합니다.')
      .addToggle((t) => t.setValue(!!s.useGeminiAi).onChange(async (v) => {
        s.useGeminiAi = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('설교 마인드맵 플러그인의 Gemini 키 자동 연동')
      .setDesc('켜면 sermon-mindmap 설정에 이미 저장된 Gemini API 키를 자동으로 불러와 함께 사용합니다.')
      .addToggle((t) => t.setValue(!!s.useMindmapGeminiKey).onChange(async (v) => {
        s.useMindmapGeminiKey = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('추가 Gemini API 키 (선택)')
      .setDesc('여러 개를 쉼표(,)나 줄바꿈으로 넣으면 429 할당량 초과 시 자동으로 다음 키로 순환합니다.')
      .addTextArea((t) => {
        t.setPlaceholder('AIza..., AIza...');
        t.setValue(s.geminiApiKeys || '');
        t.inputEl.rows = 3;
        t.onChange(async (v) => { s.geminiApiKeys = v; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName('Gemini 기본 모델')
      .addDropdown((d) => d
        .addOption('gemini-2.5-flash', 'gemini-2.5-flash (권장 · 균형)')
        .addOption('gemini-2.5-flash-lite', 'gemini-2.5-flash-lite (빠름)')
        .addOption('gemini-3-flash-preview', 'gemini-3-flash-preview (고정밀)')
        .setValue(s.geminiModel || 'gemini-2.5-flash')
        .onChange(async (v) => { s.geminiModel = v; await this.plugin.saveSettings(); }));
  }
}

class SermonMdRefinerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.addRibbonIcon('wand-2', '현재 노트 서식 다듬기 (HWP/DOCX/복붙 정리)', () => {
      this.openRefineModal();
    });

    this.addCommand({
      id: 'open-sermon-md-refiner',
      name: '현재 노트 서식 다듬기 창 열기 (규칙 · AI 정리)',
      editorCallback: (editor, view) => {
        this.openRefineModal(editor, view);
      }
    });

    this.addCommand({
      id: 'quick-rules-refine-note',
      name: '현재 노트 즉시 빠른 규칙 정리 실행 (Ctrl+Z 되돌리기)',
      editorCallback: (editor) => {
        const sel = editor.getSelection();
        if (sel && sel.trim()) {
          editor.replaceSelection(refineMarkdownByRules(sel, this.settings));
          new Notice('⚡ 선택 영역 규칙 정리 완료');
          return;
        }
        const full = editor.getValue();
        const refined = refineMarkdownByRules(full, this.settings);
        if (refined === full) {
          new Notice('이미 깔끔하게 정돈된 노트입니다.');
          return;
        }
        const fullEnd = { line: editor.lastLine(), ch: editor.getLine(editor.lastLine()).length };
        editor.replaceRange(refined, { line: 0, ch: 0 }, fullEnd);
        new Notice('⚡ 노트 규칙 정리 완료 (Ctrl+Z로 되돌리기 가능)');
      }
    });

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, view) => {
        menu.addItem((item) => {
          item
            .setTitle('✨ 노트 서식 다듬기 (HWP/복붙 정리)')
            .setIcon('wand-2')
            .onClick(() => this.openRefineModal(editor, view));
        });
      })
    );

    const attachHeaderButtons = () => {
      this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
        const view = leaf.view;
        if (!view || view._smrHeaderAdded || typeof view.addAction !== 'function') return;
        view._smrHeaderAdded = true;
        view.addAction('wand-2', '노트 서식 다듬기', () => {
          this.openRefineModal(view.editor, view);
        });
      });
    };

    this.registerEvent(this.app.workspace.on('layout-change', attachHeaderButtons));
    this.registerEvent(this.app.workspace.on('active-leaf-change', attachHeaderButtons));
    this.app.workspace.onLayoutReady(attachHeaderButtons);

    this.addSettingTab(new SermonMdRefinerSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.defaultMode = 'ai_struct';
    this.settings.quoteStandaloneVerses = false;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  openRefineModal(editorArg = null, viewArg = null) {
    const view = viewArg || this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) {
      new Notice('먼저 다듬을 마크다운(.md) 노트를 열어주세요.');
      return;
    }
    const editor = editorArg || view.editor;
    const selectionText = editor ? editor.getSelection() : '';
    const fullText = editor ? editor.getValue() : '';
    new SermonMdRefineModal(this.app, this, {
      file: view.file,
      editor,
      selectionText,
      fullText
    }).open();
  }

  async createBackupCopy(file, rawText) {
    const parent = file.parent && file.parent.path !== '/' ? `${file.parent.path}/` : '';
    let bakPath = `${parent}${file.basename}_원본백업.md`;
    let n = 2;
    while (await this.app.vault.adapter.exists(bakPath)) {
      bakPath = `${parent}${file.basename}_원본백업_${n++}.md`;
    }
    await this.app.vault.create(bakPath, rawText);
  }

  collectGeminiKeys() {
    const keys = [];
    const raw = (this.settings.geminiApiKeys || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    keys.push(...raw);
    if (this.settings.useMindmapGeminiKey) {
      try {
        const mm = this.app?.plugins?.plugins?.['sermon-mindmap'];
        const mmKey = mm?.settings?.geminiApiKey;
        if (mmKey && typeof mmKey === 'string' && !keys.includes(mmKey.trim())) {
          keys.push(mmKey.trim());
        }
      } catch (e) { /* ignore */ }
    }
    return Array.from(new Set(keys));
  }

  async callGeminiChunk(prompt, keys, abortSignal, reqOpts = {}) {
    const models = Array.from(new Set([
      this.settings.geminiModel || 'gemini-2.5-flash',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-3-flash-preview'
    ]));
    const keyOffset = Number.isFinite(reqOpts.keyOffset) ? reqOpts.keyOffset : 0;

    let lastErr = null;
    for (const model of models) {
      for (let ki = 0; ki < keys.length; ki++) {
        const key = keys[(ki + keyOffset) % keys.length];
        if (abortSignal && abortSignal.aborted) {
          const ae = new Error('Aborted');
          ae.name = 'AbortError';
          throw ae;
        }
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
          const generationConfig = {
            temperature: 0.1,
            maxOutputTokens: reqOpts.maxOutputTokens || 65536
          };
          if (model.startsWith('gemini-2.5-')) {
            // Turn off default thinking tokens to eliminate 10-40s latency overhead per chunk
            generationConfig.thinkingConfig = { thinkingBudget: 0 };
          }
          const res = await requestUrl({
            url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig
            }),
            throw: false
          });
          if (res.status === 200 && res.json) {
            const txt = res.json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (txt.trim()) {
              return txt.replace(/^```(?:markdown|md)?\r?\n?/i, '').replace(/\r?\n?```$/i, '').trim();
            }
          }
          lastErr = new Error(`HTTP ${res.status} (${model})`);
          if (res.status !== 429 && res.status !== 503 && res.status !== 404) {
            // Invalid key / bad request -> try next key
            continue;
          }
        } catch (err) {
          lastErr = err;
        }
      }
    }
    throw lastErr || new Error('Gemini API 호출에 실패했습니다.');
  }

  async refineWithGemini(rawText, mode, customNote, onProgress, abortSignal, headingScope, autoNumberedStyle, stripQuotesOrOpts) {
    const keys = this.collectGeminiKeys();
    if (!keys.length) {
      throw new Error('Gemini API 키가 없습니다. 설정 > 노트 서식 다듬기에서 키를 입력하거나 설교 마인드맵 키 연동을 켜주세요.');
    }

    const extraOpts = (stripQuotesOrOpts && typeof stripQuotesOrOpts === 'object') ? stripQuotesOrOpts : {};
    const effectiveScope = headingScope || extraOpts.headingLevelScope || this.settings.headingLevelScope || 'h1_h6';
    const effectiveNumStyle = autoNumberedStyle || extraOpts.autoNumberedStyle || this.settings.autoNumberedStyle || 'smart';
    const effectiveDocProfile = extraOpts.docProfile || this.settings.docProfile || 'sermon';
    const effectiveStripQuotes = typeof stripQuotesOrOpts === 'boolean'
      ? stripQuotesOrOpts
      : (typeof extraOpts.stripVerseBlockquotes === 'boolean' ? extraOpts.stripVerseBlockquotes : !!this.settings.stripVerseBlockquotes);

    const effectiveRuleOpts = Object.assign({}, this.settings, extraOpts, {
      docProfile: effectiveDocProfile,
      headingLevelScope: effectiveScope,
      autoNumberedStyle: effectiveNumStyle,
      stripVerseBlockquotes: effectiveStripQuotes
    });

    // Non-destructive prep: keep raw outline intact so AI sees real semantics, while unescaping Pandoc artifacts and stitching hard-wrapped half-sentences
    const { frontmatter: origFm, body: origBody } = splitFrontmatter(rawText);
    const origQuotedKeys = extractQuotedVerseKeys(origBody);
    let cleanBody = convertHtmlParagraphAndBreakTags(
      normalizeHwpDashBullets(unescapePandocMarkdown(decodeHtmlEntities(origBody)))
    )
      .replace(/\r\n/g, '\n')
      .replace(/[\u00A0\u200B\uFEFF]/g, (ch) => (ch === '\u00A0' ? ' ' : ''));
    let frontmatter = origFm;
    if (!frontmatter && effectiveRuleOpts.addMissingFrontmatter) {
      const ext = extractLeadingMetadataFrontmatter(cleanBody.split('\n'));
      if (ext.generatedFm) {
        frontmatter = ext.generatedFm;
        cleanBody = cleanBody.split('\n').slice(ext.startIdx).join('\n');
      }
    }
    if (effectiveRuleOpts.mergeBrokenLines !== false) {
      let prepLines = splitInlineNumberedItemsPass(
        cleanBody.split('\n').map((l) => l.replace(/[ \t]+$/g, '')),
        effectiveDocProfile === 'general'
      );
      if (effectiveRuleOpts.normalizeBibleRefs !== false) {
        prepLines = splitAndNormalizeBiblePassagesPass(prepLines, effectiveRuleOpts);
      }
      cleanBody = mergeBrokenLinesPass(prepLines, effectiveRuleOpts.vaultBasePath || '').join('\n');
    }
    cleanBody = convertPandocUnderlineTags(cleanBody);

    // Use larger semantic chunks (11,000 chars); only run separate whole-doc outline pass when split across multiple chunks
    const chunks = splitIntoChunks(cleanBody, 11000);
    let globalOutlinePlan = '';
    if (chunks.length > 1) {
      if (abortSignal && abortSignal.aborted) {
        const ae = new Error('Aborted');
        ae.name = 'AbortError';
        throw ae;
      }
      if (onProgress) {
        onProgress('🧭 전체 문서 목차(제목1~6) 계층 설계 중...');
      }
      try {
        const planPrompt = buildGlobalOutlinePlanPrompt(cleanBody, effectiveScope, customNote, effectiveDocProfile);
        const rawPlan = await this.callGeminiChunk(planPrompt, keys, abortSignal, { maxOutputTokens: 4096 });
        const planLines = rawPlan.split('\n').map((l) => l.trim()).filter((l) => /^#{1,6}\s+/.test(l));
        if (planLines.length > 0) {
          globalOutlinePlan = planLines.join('\n');
        }
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        // Fallback smoothly to per-chunk prompt if planning hits transient error
      }
    }

    const outChunks = new Array(chunks.length);
    const effectiveMode = mode || 'ai_struct';
    if (chunks.length <= 1) {
      if (abortSignal && abortSignal.aborted) {
        const ae = new Error('Aborted');
        ae.name = 'AbortError';
        throw ae;
      }
      if (onProgress) {
        onProgress('✨ AI 맞춤법·구조화 정리 중...');
      }
      const prompt = buildAiPrompt(effectiveMode, chunks[0] || '', customNote, effectiveScope, effectiveNumStyle, {
        globalOutlinePlan: '',
        prevTail: ''
      }, effectiveDocProfile);
      outChunks[0] = await this.callGeminiChunk(prompt, keys, abortSignal);
    } else {
      let nextIdx = 0;
      let doneCount = 0;
      const concurrency = Math.min(keys.length > 1 ? 3 : 2, chunks.length);
      if (onProgress) {
        onProgress(`✨ 본문 다듬기 및 하이어라키 병렬 적용 중 (0 / ${chunks.length} 구간)...`);
      }
      const runWorker = async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= chunks.length) return;
          if (abortSignal && abortSignal.aborted) {
            const ae = new Error('Aborted');
            ae.name = 'AbortError';
            throw ae;
          }
          const prevTail = i > 0 && chunks[i - 1]
            ? chunks[i - 1].slice(-300)
            : '';
          const prompt = buildAiPrompt(effectiveMode, chunks[i], customNote, effectiveScope, effectiveNumStyle, {
            globalOutlinePlan,
            prevTail
          }, effectiveDocProfile);
          outChunks[i] = await this.callGeminiChunk(prompt, keys, abortSignal, { keyOffset: i });
          doneCount++;
          if (onProgress) {
            onProgress(`✨ 본문 다듬기 및 하이어라키 병렬 적용 중 (${doneCount} / ${chunks.length} 구간)...`);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
    }

    const hasCustomNote = Boolean(customNote && customNote.trim());
    let assembled = outChunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (assembled) {
      if (!effectiveStripQuotes) {
        assembled = stripAiAddedVerseBlockquotes(assembled, origQuotedKeys);
      }
      if (onProgress) {
        onProgress('🔍 전체 문서 규칙 마무리·제목 계층·성구 1회 완성 검수 중...');
      }
      // Run full convergent rule pipeline on BOTH merged (ai_proof) and ai_struct so Click 1 immediately promotes headings & normalizes outlines
      const postBody = refineMarkdownByRules(assembled, Object.assign({}, effectiveRuleOpts, {
        addMissingFrontmatter: false,
        fromAiPass: true,
        preserveExistingHeadings: hasCustomNote,
        respectAiHeadings: hasCustomNote,
        useSelectionOnly: true
      }));
      assembled = postBody.trim();
    }

    const joined = assembled;
    const finalHead = applyDocProfileFrontmatter(frontmatter, effectiveDocProfile === 'general', !!extraOpts.useSelectionOnly);
    if (finalHead) {
      const cleanHead = finalHead.endsWith('\n') ? finalHead : finalHead + '\n';
      return cleanHead + (joined ? joined + '\n' : '');
    }
    return joined ? joined + '\n' : '';
  }
}

SermonMdRefinerPlugin.refineMarkdownByRules = refineMarkdownByRules;
SermonMdRefinerPlugin.splitIntoChunks = splitIntoChunks;
SermonMdRefinerPlugin.normalizeBibleRefsInLine = normalizeBibleRefsInLine;
SermonMdRefinerPlugin.reconcileDocumentStructure = reconcileDocumentStructure;

module.exports = SermonMdRefinerPlugin;
