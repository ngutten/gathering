// render.js — Pure rendering utilities

import { apiUrl } from './config.js';
import { convertShortcodes } from './emoji.js';

export function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function unescapeHtml(s) {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}

export function renderRichContent(raw) {
  let text = escapeHtml(raw);

  // Placeholder system to protect rendered HTML (LaTeX, code) from subsequent regex passes
  const placeholders = [];
  function placeholder(html) {
    const id = '\x00PH' + placeholders.length + '\x00';
    placeholders.push(html);
    return id;
  }

  // Block-level LaTeX $$...$$ (before code blocks)
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    try {
      if (typeof katex !== 'undefined') {
        return placeholder('<div class="katex-display">' + katex.renderToString(unescapeHtml(tex), { displayMode: true, throwOnError: false }) + '</div>');
      }
    } catch(e) {}
    return '$$' + tex + '$$';
  });

  // Code blocks with optional language: ```lang\n...\n```
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const highlighted = lang ? highlightSyntax(unescapeHtml(code), lang) : escapeHtml(unescapeHtml(code));
    const langTag = lang ? `<span class="lang-tag">${lang}</span>` : '';
    return placeholder(`<pre>${langTag}<code>${highlighted}</code></pre>`);
  });

  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, code) => placeholder('<code>' + code + '</code>'));

  // Inline LaTeX $...$
  text = text.replace(/\$([^\$\n]+?)\$/g, (_, tex) => {
    try {
      if (typeof katex !== 'undefined') {
        return placeholder(katex.renderToString(unescapeHtml(tex), { throwOnError: false }));
      }
    } catch(e) {}
    return '$' + tex + '$';
  });

  // Bold, italic, strikethrough
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links [text](url)
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Auto-link URLs (not already inside href or tags)
  text = text.replace(/(^|[^"=])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  // Blockquotes (lines starting with >)
  text = text.replace(/(^|\n)&gt; (.+)/g, '$1<blockquote>$2</blockquote>');
  // Merge adjacent blockquotes
  text = text.replace(/<\/blockquote>\n?<blockquote>/g, '\n');

  // Bullet lists (lines starting with - )
  text = text.replace(/((?:^|\n)- .+(?:\n- .+)*)/g, (match) => {
    const items = match.trim().split('\n').map(line =>
      '<li>' + line.replace(/^- /, '') + '</li>'
    ).join('');
    return '<ul>' + items + '</ul>';
  });

  // Newlines to <br> (but not inside pre/blockquote)
  text = text.replace(/\n/g, '<br>');

  // Convert :shortcodes: to emoji (before restoring placeholders)
  text = convertShortcodes(text);

  // Restore placeholders
  text = text.replace(/\x00PH(\d+)\x00/g, (_, i) => placeholders[parseInt(i)]);

  return text;
}

export function highlightSyntax(code, lang) {
  const keywords = {
    js: new Set(['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','new','this','try','catch','throw','switch','case','break','default','typeof','instanceof','in','of','true','false','null','undefined','void']),
    ts: new Set(['const','let','var','function','return','if','else','for','while','class','import','export','from','async','await','new','this','try','catch','throw','switch','case','break','default','typeof','instanceof','in','of','true','false','null','undefined','void','type','interface','enum','implements','extends','readonly','as','is']),
    rust: new Set(['fn','let','mut','pub','struct','enum','impl','use','mod','self','Self','crate','super','trait','where','async','await','move','return','if','else','for','while','loop','match','break','continue','true','false','Some','None','Ok','Err','type','const','static','unsafe','extern','ref','as','in']),
    python: new Set(['def','class','import','from','return','if','elif','else','for','while','try','except','finally','with','as','in','is','not','and','or','True','False','None','self','lambda','yield','raise','pass','break','continue','global','nonlocal','assert','del']),
    go: new Set(['func','package','import','return','if','else','for','range','switch','case','default','var','const','type','struct','interface','map','chan','go','defer','select','break','continue','true','false','nil','make','len','append','cap']),
    sql: new Set(['select','from','where','insert','into','values','update','set','delete','create','table','alter','drop','index','join','left','right','inner','outer','on','and','or','not','null','is','in','like','order','by','group','having','limit','offset','as','distinct','count','sum','avg','min','max','if','exists','primary','key','foreign','references','default','text','integer','real','blob']),
    sh: new Set(['if','then','else','fi','for','do','done','while','case','esac','function','return','exit','echo','export','source','cd','ls','rm','cp','mv','mkdir','grep','sed','awk','cat','chmod','chown','sudo','apt','yum','brew','npm','cargo','git']),
    html: new Set(['div','span','input','button','form','table','body','head','html','script','style','link','meta','title','class','id','src','href','type','name','value','onclick','onchange']),
    css: new Set(['color','background','border','margin','padding','display','flex','grid','position','width','height','font','text','align','justify','content','items','none','solid','auto','inherit','relative','absolute','fixed','block','inline']),
  };
  keywords.javascript = keywords.js;
  keywords.typescript = keywords.ts;
  keywords.rs = keywords.rust;
  keywords.py = keywords.python;
  keywords.bash = keywords.sh;

  const langNorm = lang.toLowerCase();
  const kwSet = keywords[langNorm];
  const isSql = (langNorm === 'sql');

  const hashCommentLangs = new Set(['python','py','sh','bash','ruby','rb','perl','pl','yaml','yml','toml','r']);
  const slashCommentLangs = new Set(['js','javascript','ts','typescript','rust','rs','go','java','c','cpp','cs','css','sql']);
  const useHash = hashCommentLangs.has(langNorm);
  const useSlash = slashCommentLangs.has(langNorm) || !langNorm;

  const parts = [];
  if (useSlash) { parts.push('\/\/.*$'); parts.push('\/\\*[\\s\\S]*?\\*\/'); }
  if (useHash) { parts.push('#.*$'); }
  parts.push('"(?:[^"\\\\]|\\\\.)*"');
  parts.push("'(?:[^'\\\\]|\\\\.)*'");
  parts.push('`(?:[^`\\\\]|\\\\.)*`');
  parts.push('\\b\\d+\\.?\\d*(?:e[+-]?\\d+)?\\b');
  parts.push('[a-zA-Z_]\\w*');
  parts.push('[\\s\\S]');
  const tokenRe = new RegExp(parts.join('|'), 'gm');

  let result = '';
  let m;
  while ((m = tokenRe.exec(code)) !== null) {
    const tok = m[0];
    const esc = escapeHtml(tok);
    if ((useSlash && (tok.startsWith('//') || tok.startsWith('/*'))) || (useHash && tok.startsWith('#'))) {
      result += `<span class="cm">${esc}</span>`;
    } else if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'")) || (tok.startsWith('`') && tok.endsWith('`'))) {
      result += `<span class="str">${esc}</span>`;
    } else if (/^\d/.test(tok)) {
      result += `<span class="num">${esc}</span>`;
    } else if (kwSet && /^[a-zA-Z_]/.test(tok)) {
      const lookup = isSql ? tok.toLowerCase() : tok;
      if (kwSet.has(lookup)) {
        result += `<span class="kw">${esc}</span>`;
      } else {
        result += esc;
      }
    } else {
      result += esc;
    }
  }
  return result;
}

export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function isImageMime(mime) {
  return /^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(mime);
}

export function isAudioMime(mime) {
  return /^audio\//.test(mime);
}

export function isVideoMime(mime) {
  return /^video\//.test(mime);
}

export function formatTimeAgo(isoStr) {
  const diff = Math.max(0, Math.round((Date.now() - new Date(isoStr).getTime()) / 1000));
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

export function renderTtlBadge(expiresAt) {
  if (!expiresAt) return '';
  const exp = new Date(expiresAt);
  const remaining = Math.max(0, Math.round((exp - Date.now()) / 1000));
  if (remaining < 60) return `<span class="ttl">[${remaining}s]</span>`;
  if (remaining < 3600) return `<span class="ttl">[${Math.round(remaining/60)}m]</span>`;
  if (remaining < 86400) return `<span class="ttl">[${Math.round(remaining/3600)}h]</span>`;
  return `<span class="ttl">[${Math.round(remaining/86400)}d]</span>`;
}

export function renderAttachmentsHtml(attachments) {
  if (!attachments || attachments.length === 0) return '';
  let html = '<div class="attachments">';
  for (const att of attachments) {
    const url = escapeHtml(apiUrl(att.url));
    if (isImageMime(att.mime_type)) {
      html += `<a href="${url}" target="_blank"><img class="attachment-img" src="${url}" alt="${escapeHtml(att.filename)}" loading="lazy"></a>`;
    } else if (isAudioMime(att.mime_type)) {
      html += `<div class="attachment-audio"><div class="file-name">${escapeHtml(att.filename)} <span class="file-size">(${formatFileSize(att.size)})</span></div><audio controls preload="metadata" src="${url}"></audio></div>`;
    } else if (isVideoMime(att.mime_type)) {
      html += `<video controls preload="metadata" src="${url}" style="max-width:400px;max-height:300px;border-radius:4px;margin-top:0.3rem;"></video>`;
    } else {
      html += `<div class="attachment"><a href="${url}" download="${escapeHtml(att.filename)}">${escapeHtml(att.filename)}</a> <span class="file-size">${formatFileSize(att.size)}</span></div>`;
    }
  }
  html += '</div>';
  return html;
}
