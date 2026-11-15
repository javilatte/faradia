'use strict';

// Patterns of the plane 2 watchlist, with the .gitignore semantics users already know:
//   .env          no slash: matches that name in any folder
//   /.env         leading slash: only at the repo root
//   dist/**       everything inside dist/ (at the root)
//   *.log         any .log file, in any folder
//   config/*.json one level: config/a.json yes, config/x/a.json no
// Paths are always compared relative to the repo and with "/".

function escape(ch) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegExp(pattern) {
  let p = String(pattern).trim();
  if (!p) return null;
  let anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.endsWith('/')) p += '**';
  // No slash in the middle: matches at any level (like .gitignore).
  if (!p.includes('/')) anchored = false;
  else anchored = true;

  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        const slashAfter = p[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += escape(ch);
    }
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`);
}

/** Returns a function (relativePath) => boolean for a list of patterns. */
function compileGlobs(patterns) {
  const res = (patterns || []).map(globToRegExp).filter(Boolean);
  return (rel) => {
    const path = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
    return res.some((re) => re.test(path));
  };
}

/**
 * Fixed folder at the start of a pattern ("dist/**" -> "dist", "a/b/*.js" -> "a/b"). Used to know
 * which ignored folders must be watched. null if the pattern matches in any folder (no slash) or
 * starts with a wildcard.
 */
function staticPrefix(pattern) {
  let p = String(pattern).trim().replace(/^\//, '');
  if (!p.includes('/')) return null;
  const parts = p.split('/');
  const fixed = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?[]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.length ? fixed.join('/') : null;
}

module.exports = { globToRegExp, compileGlobs, staticPrefix };
