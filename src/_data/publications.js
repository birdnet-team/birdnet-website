const fs = require("fs");
const path = require("path");
const bibtexParse = require("bibtex-parse-js");

// Very small LaTeX accents -> Unicode helper
function latexToUnicode(str) {
  if (!str) return "";

  // Handle specific multi-char patterns first
  const specials = [
    { re: /\\~\{n\}|\\~n/g, ch: "ñ" },
    { re: /\\~\{N\}|\\~N/g, ch: "Ñ" },
  ];
  specials.forEach((s) => {
    str = str.replace(s.re, s.ch);
  });

  // Generic accent maps: \'{a}, {\'a}, \"{o}, etc.
  const accentMap = {
    a: "á",
    e: "é",
    i: "í",
    o: "ó",
    u: "ú",
    A: "Á",
    E: "É",
    I: "Í",
    O: "Ó",
    U: "Ú",
  };

  const umlautMap = {
    a: "ä",
    e: "ë",
    i: "ï",
    o: "ö",
    u: "ü",
    A: "Ä",
    E: "Ë",
    I: "Ï",
    O: "Ö",
    U: "Ü",
  };

  const graveMap = {
    a: "à",
    e: "è",
    i: "ì",
    o: "ò",
    u: "ù",
    A: "À",
    E: "È",
    I: "Ì",
    O: "Ò",
    U: "Ù",
  };

  // Helper to apply a map for patterns like {\'a}, \'a, etc.
  function applyAccentPatterns(s, symbol, map) {
    const reBraced = new RegExp(`\\{\\\\${symbol}([A-Za-z])\\}`, "g");
    const rePlain = new RegExp(`\\\\${symbol}([A-Za-z])`, "g");
    s = s.replace(reBraced, (_, letter) => map[letter] || letter);
    s = s.replace(rePlain, (_, letter) => map[letter] || letter);
    return s;
  }

  // Acute accents \'
  str = applyAccentPatterns(str, "'", accentMap);
  // Umlaut \"
  str = applyAccentPatterns(str, '"', umlautMap);
  // Grave accents \`
  str = applyAccentPatterns(str, "`", graveMap);

  // Remove remaining braces that just group things
  str = str.replace(/[{}]/g, "");

  return str;
}

function parseAuthors(authorField) {
  if (!authorField) return [];
  // BibTeX authors are typically separated by " and "
  return authorField
    .split(/\s+and\s+/)
    .map((a) => latexToUnicode(a.trim()))
    .filter(Boolean);
}

// Add: parse tags from BibTeX "tags" field (comma-separated)
function parseTags(val) {
  if (!val) return [];
  return String(val)
    .replace(/[{}]/g, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

module.exports = function () {
  const bibPath = path.join(process.cwd(), "data", "publications.bib");

  let raw;
  try {
    raw = fs.readFileSync(bibPath, "utf8");
  } catch (err) {
    console.warn("[publications] Could not read publications.bib:", err.message);
    return { list: [], byYear: [] };
  }

  const entries = bibtexParse.toJSON(raw);

  const pubs = entries.map((e) => {
    const f = e.entryTags || {};
    return {
      id: e.citationKey,
      type: e.entryType,
      title: latexToUnicode(f.title || ""),
      authors: parseAuthors(f.author || ""),
      journal: latexToUnicode(f.journal || ""),
      year: f.year ? Number(f.year) : null,
      volume: f.volume || "",
      number: f.number || "",
      pages: f.pages || "",
      publisher: latexToUnicode(f.publisher || ""),
      tags: parseTags(f.tags || ""), // <-- add tags array
      url: f.url || "",              // <-- add url
      summary: latexToUnicode(f.summary || ""), // <-- add summary
    };
  });

  // Sort descending by year, then by title
  pubs.sort((a, b) => {
    if (b.year !== a.year) return (b.year || 0) - (a.year || 0);
    return (a.title || "").localeCompare(b.title || "");
  });

  // Group by year
  const byYearMap = {};
  for (const p of pubs) {
    const year = p.year || "Unknown";
    if (!byYearMap[year]) {
      byYearMap[year] = [];
    }
    byYearMap[year].push(p);
  }

  const byYear = Object.keys(byYearMap)
    .sort((a, b) => Number(b || 0) - Number(a || 0))
    .map((year) => ({
      year,
      items: byYearMap[year],
    }));

  return {
    list: pubs,
    byYear,
  };
};
