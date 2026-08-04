// todo-ui.mjs — pure ANSI rendering for the todo list (zero deps, zero I/O).
// Callers resolve env/argv/TTY into opts via resolveOptions; this module only
// turns data + opts into strings. Used by todo.mjs (cmdList) and todo-watch.mjs.

// ---- color / options -------------------------------------------------------

/**
 * Color precedence (no-color.org + FORCE_COLOR + TTY):
 * 1. --color always → true
 * 2. --color never  → false
 * 3. NO_COLOR set   → false
 * 4. FORCE_COLOR set → true
 * 5. else → isTTY
 */
function resolveColor(colorFlag, env, isTTY) {
  if (colorFlag === "always") return true;
  if (colorFlag === "never") return false;
  if (env && env.NO_COLOR !== undefined) return false;
  if (env && env.FORCE_COLOR !== undefined) return true;
  return !!isTTY;
}

/**
 * resolveOptions(env, argv, isTTY) → opts
 * width is left unset; the caller fills process.stdout.columns ?? 80.
 * densityExplicit tracks whether --density was passed (auto-compact under 60).
 */
function resolveOptions(env, argv, isTTY) {
  const args = argv || {};
  const all = !!args.all;
  const ascii = !!args.ascii;
  const densityExplicit = args.density != null && args.density !== "";
  let density = densityExplicit ? String(args.density) : "normal";
  if (!["compact", "normal", "relaxed"].includes(density)) density = "normal";

  const color = resolveColor(args.color, env || {}, isTTY);

  let mode;
  if (args.plain === true) {
    mode = "grouped";
  } else if (!isTTY && color === false) {
    mode = "flat";
  } else {
    mode = "styled";
  }

  return {
    mode,
    color,
    ascii,
    density,
    densityExplicit,
    all,
    // width filled by caller
  };
}

// ---- ANSI helpers ----------------------------------------------------------

/**
 * SGR wrap. Call as c(text, opts, ...codes) or c(text, ...codes).
 * When opts.color === false, return text unchanged.
 */
function c(text, ...args) {
  let color = true;
  let codes = args;
  if (args.length > 0 && typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0])) {
    color = args[0].color !== false;
    codes = args.slice(1);
  }
  if (!color || codes.length === 0) return text;
  return `\x1b[${codes.join(";")}m${text}\x1b[0m`;
}

function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLen(str) {
  return stripAnsi(str).length;
}

const GLYPHS = {
  open: { unicode: "☐", ascii: "[ ]" },
  done: { unicode: "✓", ascii: "[x]" },
  sep: { unicode: "·", ascii: "*" },
  arrow: { unicode: "↻", ascii: "@" },
  tl: { unicode: "┌", ascii: "+" },
  tr: { unicode: "┐", ascii: "+" },
  bl: { unicode: "└", ascii: "+" },
  br: { unicode: "┘", ascii: "+" },
  h: { unicode: "─", ascii: "-" },
  v: { unicode: "│", ascii: "|" },
};

function glyph(name, opts) {
  const g = GLYPHS[name];
  if (!g) return "";
  return opts && opts.ascii ? g.ascii : g.unicode;
}

function fitWidth(opts, fallback = 80) {
  const w = opts && opts.width;
  return typeof w === "number" && w > 0 ? w : fallback;
}

/** Ellipsis-truncate plain text to max visible chars. */
function truncate(text, max, _opts) {
  const s = String(text);
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max === 1) return "…";
  return s.slice(0, max - 1) + "…";
}

// ---- due dates -------------------------------------------------------------

/**
 * dueState(dueStr, today) → "overdue" | "soon" | "normal"
 * today is a Date (local calendar day). dueStr is "YYYY-MM-DD".
 */
function dueState(dueStr, today) {
  if (!dueStr || !/^\d{4}-\d{2}-\d{2}$/.test(dueStr)) return "normal";
  const t = today instanceof Date ? today : new Date();
  const todayMid = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  const [yy, mm, dd] = dueStr.split("-").map(Number);
  const dueMid = new Date(yy, mm - 1, dd);
  const diffDays = Math.round((dueMid - todayMid) / 86400000);
  if (diffDays < 0) return "overdue";
  if (diffDays <= 2) return "soon";
  return "normal";
}

function localToday() {
  return new Date();
}

function formatDueLabel(tag, opts, today) {
  // tag is "due:YYYY-MM-DD"
  const due = tag.slice(4);
  const state = dueState(due, today);
  if (!opts.color && state === "overdue") return tag + "!";
  return tag;
}

// ---- task rendering --------------------------------------------------------

/**
 * Byte-stable plain task line (exact extraction of former todo.mjs renderTask).
 * Open-task t: stamps are filtered out.
 */
function renderTaskPlain(t) {
  const prio = t.priority ? `(${t.priority}) ` : "";
  const tags = t.tags
    .filter((tag) => !(t.open && /^t:\d{4}-\d{2}-\d{2}$/.test(tag)))
    .join(" ");
  return `${prio}${t.clean}${tags ? "  " + tags : ""}`;
}

function filterDisplayTags(t) {
  return t.tags.filter((tag) => !(t.open && /^t:\d{4}-\d{2}-\d{2}$/.test(tag)));
}

function partitionTags(tags) {
  const due = [];
  const other = [];
  for (const tag of tags) {
    if (/^due:\d{4}-\d{2}-\d{2}$/.test(tag)) due.push(tag);
    else other.push(tag);
  }
  return { due, other };
}

/**
 * Choose clean + which droppable tags fit in `avail` columns after the prefix.
 * due: tags are never dropped; +proj/@ctx/t: drop first; then truncate clean.
 * Prefer full clean over keeping droppable tags.
 * relaxed density disables clean truncation (may overflow).
 */
function fitTaskContent(clean, due, other, avail, opts, today, noTruncate) {
  const dueLabels = due.map((tag) => formatDueLabel(tag, opts, today));
  const dueStr = dueLabels.join(" ");

  if (noTruncate) {
    return { clean, others: other, dueLabels };
  }

  const tagBudgetFor = (others) => {
    const parts = [];
    if (dueStr) parts.push(dueStr);
    if (others.length) parts.push(others.join(" "));
    const tagStr = parts.join(" ");
    return tagStr ? 2 + tagStr.length : 0;
  };

  // 1) Prefer full clean + all tags
  if (tagBudgetFor(other) + clean.length <= avail) {
    return { clean, others: other, dueLabels };
  }

  // 2) Drop +proj/@ctx/t: to free room for full clean + due:
  if (tagBudgetFor([]) + clean.length <= avail) {
    return { clean, others: [], dueLabels };
  }

  // 3) Truncate clean; keep due: (and other tags only if they still fit after clean min)
  const dueBudget = tagBudgetFor([]);
  const cleanBudget = Math.max(0, avail - dueBudget);
  const truncated = cleanBudget > 0 ? truncate(clean, cleanBudget) : "";

  // If after reserving due + truncated clean there is leftover, try re-adding others
  // (usually none — skip for simplicity: once we truncate, drop droppable tags)
  return { clean: truncated, others: [], dueLabels };
}

function styleTagLabel(tag, label, opts, today, forceBold) {
  if (!opts.color) return label;
  if (/^due:\d{4}-\d{2}-\d{2}$/.test(tag)) {
    const due = tag.slice(4);
    const state = dueState(due, today);
    if (state === "overdue") return c(label, opts, 1, 31);
    if (state === "soon") return c(label, opts, 1, 33);
    return c(label, opts, ...(forceBold ? [1, 2] : [2]));
  }
  // @ctx, +proj, t:
  return c(label, opts, ...(forceBold ? [1, 2] : [2]));
}

/**
 * Styled task line: <glyph> <prio> <clean>  <tags>
 * Width-aware; never cuts (A) priority token or due: tags.
 */
function renderTaskStyled(t, opts) {
  const o = opts || {};
  const today = o.today || localToday();
  const width = fitWidth(o);
  const density = o.density || "normal";
  const noTruncate = density === "relaxed";
  const forceBold = t.priority === "A"; // Phase 2: whole (A) row bold

  const gName = t.open ? "open" : "done";
  const glyphStr = glyph(gName, o);
  const prio = t.priority ? `(${t.priority})` : "";
  const prioPlain = prio ? prio + " " : "";
  const prefixPlain = `${glyphStr} ${prioPlain}`;

  const tags = filterDisplayTags(t);
  const { due, other } = partitionTags(tags);

  const avail = noTruncate ? Infinity : Math.max(0, width - visibleLen(prefixPlain));
  const fitted = fitTaskContent(t.clean || "", due, other, avail, o, today, noTruncate);

  // Build plain labels for tags (due may have "!")
  const tagPlainParts = [];
  for (const label of fitted.dueLabels) tagPlainParts.push(label);
  for (const tag of fitted.others) tagPlainParts.push(tag);
  const tagsPlain = tagPlainParts.join(" ");

  // ---- Done path: dim + strikethrough; glyph dim-green ----
  if (!t.open) {
    const bodyPlain = `${glyphStr} ${prioPlain}${fitted.clean}${tagsPlain ? "  " + tagsPlain : ""}`;
    if (!o.color) return bodyPlain;
    const rest = bodyPlain.slice(glyphStr.length); // leading space + rest
    return c(glyphStr, o, 2, 32) + c(rest, o, 2, 9);
  }

  // ---- Open path ----
  let gStyled = glyphStr;
  let prioStyled = "";
  if (prio) {
    if (t.priority === "A") prioStyled = c(prio, o, 1, 31) + " ";
    else if (t.priority === "B") prioStyled = c(prio, o, 33) + " ";
    else if (t.priority === "C") prioStyled = c(prio, o, 34) + " ";
    else prioStyled = c(prio, o, 2) + " ";
  }

  let cleanStyled = fitted.clean;
  if (o.color && forceBold) {
    gStyled = c(glyphStr, o, 1);
    cleanStyled = c(fitted.clean, o, 1);
    // prio already bold for A
  }

  const styledTags = [];
  for (let i = 0; i < fitted.dueLabels.length; i++) {
    styledTags.push(styleTagLabel(due[i], fitted.dueLabels[i], o, today, forceBold));
  }
  for (const tag of fitted.others) {
    styledTags.push(styleTagLabel(tag, tag, o, today, forceBold));
  }
  const tagsPart = styledTags.length ? "  " + styledTags.join(" ") : "";

  return `${gStyled} ${prioStyled}${cleanStyled}${tagsPart}`;
}

// ---- section cards (Phase 2) -----------------------------------------------

/**
 * box(title, bodyLines, width, opts) → multi-line string
 * Wide (≥60): full box with side borders.
 * Narrow (<60): top/bottom rules only (no side borders).
 */
function box(title, bodyLines, width, opts) {
  const o = opts || {};
  const w = typeof width === "number" && width > 0 ? width : fitWidth(o);
  const h = glyph("h", o);
  const v = glyph("v", o);
  const tl = glyph("tl", o);
  const tr = glyph("tr", o);
  const bl = glyph("bl", o);
  const br = glyph("br", o);
  const wide = w >= 60;

  const titleText = String(title || "");
  const titleStyled = o.color ? c(titleText, o, 1) : titleText;

  if (wide) {
    // ┌─ Title ─────┐
    // │ body        │
    // └─────────────┘
    const inner = Math.max(0, w - 2);
    // top: tl + ─ + " " + title + " " + ─… + tr  (visual length ≈ w)
    // pieces after tl before tr: "─ title ──…" length = inner
    const afterTl = 1 + 1 + titleText.length + 1; // h + space + title + space
    const fill = Math.max(0, inner - afterTl);
    const top = tl + h + " " + titleStyled + " " + h.repeat(fill) + tr;
    const lines = [top];
    for (const body of bodyLines) {
      // Task lines are pre-fitted to width-4 (│ + pad + body + pad + │).
      // Layout: │␠<body>␠…│
      const pad = Math.max(0, inner - visibleLen(body) - 2);
      lines.push(v + " " + body + " ".repeat(pad) + " " + v);
    }
    lines.push(bl + h.repeat(inner) + br);
    return lines.join("\n");
  }

  // Narrow: ── Title ──… / body / ────
  const leftRule = h.repeat(2);
  const used = 2 + 1 + titleText.length + 1; // "── Title "
  const rightLen = Math.max(2, w - used);
  const top = leftRule + " " + titleStyled + " " + h.repeat(rightLen);
  const bottom = h.repeat(Math.max(w, 3));
  return [top, ...bodyLines, bottom].join("\n");
}

// ---- list ------------------------------------------------------------------

function withWidthDensity(opts) {
  const o = { ...opts };
  const w = fitWidth(o);
  o.width = w;
  if (w < 60 && !o.densityExplicit) {
    o.density = "compact";
  }
  return o;
}

function renderList(sections, opts) {
  const o = withWidthDensity(opts || {});
  const mode = o.mode || "flat";
  const all = !!o.all;
  const density = o.density || "normal";

  const blocks = [];
  for (const s of sections || []) {
    const tasks = (s.tasks || []).filter((t) => (all ? true : t.open));
    if (tasks.length === 0) continue;
    blocks.push({ title: s.title, tasks });
  }
  if (blocks.length === 0) return "";

  if (mode === "flat") {
    let out = "";
    for (const b of blocks) {
      for (const t of b.tasks) out += renderTaskPlain(t) + "\n";
    }
    return out.replace(/\n$/, "");
  }

  if (mode === "grouped") {
    let out = "";
    for (const b of blocks) {
      out += `\n## ${b.title}\n`;
      for (const t of b.tasks) out += "  " + renderTaskPlain(t) + "\n";
    }
    return out.replace(/\n$/, "");
  }

  // styled — card-wrapped sections
  // Wide cards (>=60): side borders + 1 pad each side → body width = width - 4.
  // Narrow cards drop sides; tasks use full width.
  const w = o.width;
  const taskOpts = {
    ...o,
    width: w >= 60 ? Math.max(1, w - 4) : w,
  };

  const parts = [];
  for (const b of blocks) {
    const bodyLines = b.tasks.map((t) => renderTaskStyled(t, taskOpts));

    let linesForBox;
    if (density === "relaxed") {
      // 1-line top/bottom padding + blank between tasks
      linesForBox = [""];
      for (let j = 0; j < bodyLines.length; j++) {
        if (j > 0) linesForBox.push("");
        linesForBox.push(bodyLines[j]);
      }
      linesForBox.push("");
    } else {
      linesForBox = bodyLines;
    }

    parts.push(box(b.title, linesForBox, w, o));
  }

  return parts.join("\n\n");
}

// ---- header / footer (pane) ------------------------------------------------

/**
 * meta = { open, perSection: [{title, open}], interval, all }
 */
function renderHeader(meta, opts) {
  const o = opts || {};
  const m = meta || {};
  const sep = glyph("sep", o);
  const arrow = glyph("arrow", o);
  const open = m.open ?? 0;
  const openStr = o.color ? c(String(open), o, 1) : String(open);
  const openLabel = `${openStr} open`;

  const per = (m.perSection || [])
    .filter((s) => s.open > 0)
    .map((s) => {
      const bit = `${s.title}:${s.open}`;
      return o.color ? c(bit, o, 2) : bit;
    });

  const refresh = `${arrow} ${m.interval ?? 4}s`;
  const refreshStyled = o.color ? c(refresh, o, 2) : refresh;
  const sepStyled = o.color ? c(` ${sep} `, o, 2) : ` ${sep} `;

  const chunks = [openLabel];
  if (per.length) chunks.push(per.join("  "));
  chunks.push(refreshStyled);
  return chunks.join(sepStyled);
}

/**
 * meta = { all, doneCount }
 */
function renderFooter(meta, opts) {
  const o = opts || {};
  const m = meta || {};
  const fname = m.file || "TODOS.md";
  let text = `edit ${fname} — updates here automatically`;
  if (m.all) {
    const n = m.doneCount ?? 0;
    text += `  (showing ${n} done)`;
  }
  return o.color ? c(text, o, 2) : text;
}

// ---- exports ---------------------------------------------------------------

export {
  resolveOptions,
  resolveColor,
  renderTaskPlain,
  renderTaskStyled,
  renderList,
  renderHeader,
  renderFooter,
  // test-visible helpers:
  c,
  glyph,
  truncate,
  visibleLen,
  stripAnsi,
  dueState,
  box,
  fitWidth,
};
