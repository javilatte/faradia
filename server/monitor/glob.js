'use strict';

// Patrones de la lista de vigilancia del plano 2, con la semantica de .gitignore
// que el usuario ya conoce:
//   .env          sin barra: coincide con ese nombre en cualquier carpeta
//   /.env         con barra inicial: solo en la raiz del repo
//   dist/**       todo lo que hay dentro de dist/ (en la raiz)
//   *.log         cualquier fichero .log, en cualquier carpeta
//   config/*.json un nivel: config/a.json si, config/x/a.json no
// Las rutas se comparan siempre relativas al repo y con "/".

function escape(ch) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function globToRegExp(pattern) {
  let p = String(pattern).trim();
  if (!p) return null;
  let anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.endsWith('/')) p += '**';
  // Sin barra en medio: vale en cualquier nivel (como .gitignore).
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

/** Devuelve una funcion (rutaRelativa) => boolean para una lista de patrones. */
function compileGlobs(patterns) {
  const res = (patterns || []).map(globToRegExp).filter(Boolean);
  return (rel) => {
    const path = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
    return res.some((re) => re.test(path));
  };
}

/**
 * Carpeta fija al principio de un patron ("dist/**" -> "dist", "a/b/*.js" -> "a/b").
 * Sirve para saber que carpetas ignoradas hay que vigilar. null si el patron vale
 * en cualquier carpeta (sin barra) o empieza por comodin.
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
