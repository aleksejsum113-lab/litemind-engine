// LiteMind Agent — построчный unified diff без внешних зависимостей.
// Входы ограничены (файлы до ~4000 строк), поэтому O(n*m) LCS приемлем;
// при превышении лимита — компактная сводка вместо полного diff.

const MAX_DIFF_LINES = 4000;

function splitLines(text) {
  if (text === '' || text == null) return [];
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = длина LCS суффиксов a[i:], b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = []; // {type: 'same'|'del'|'add', line, aLine, bLine}
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'same', line: a[i], aLine: i + 1, bLine: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', line: a[i], aLine: i + 1 }); i++; }
    else { ops.push({ type: 'add', line: b[j], bLine: j + 1 }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', line: a[i], aLine: i + 1 }); i++; }
  while (j < m) { ops.push({ type: 'add', line: b[j], bLine: j + 1 }); j++; }
  return ops;
}

/**
 * Unified diff двух текстов (как `diff -u`, контекст 3 строки).
 * Возвращает '' если изменений нет; большой вход → краткая сводка.
 */
export function unifiedDiff(oldText, newText, { context = 3, maxTotal = 400 } = {}) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return `@@ файл слишком велик для показа diff (старый: ${a.length} строк, новый: ${b.length} строк)`;
  }
  const ops = lcsOps(a, b);
  if (!ops.some((o) => o.type !== 'same')) return '';

  // Ханки: группы изменений + context одинаковых строк вокруг.
  const hunks = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'same') { k++; continue; }
    // начало ханка: отступаем context «same» назад
    let start = k;
    let ctxBefore = 0;
    while (start > 0 && ops[start - 1].type === 'same' && ctxBefore < context) { start--; ctxBefore++; }
    // если предыдущий ханк уже забрал часть этого контекста, не дублируем
    const prev = hunks[hunks.length - 1];
    if (prev && prev.end >= start) start = prev.end + 1;
    // идём вперёд до конца группы + context
    let end = k;
    let gap = 0;
    let e = k;
    while (e < ops.length) {
      if (ops[e].type === 'same') {
        gap++;
        if (gap > context * 2) break; // дальше ханк уже не продолжается
      } else {
        gap = 0;
        end = e;
      }
      e++;
    }
    let endCtx = 0;
    while (end + 1 < ops.length && ops[end + 1].type === 'same' && endCtx < context) { end++; endCtx++; }
    hunks.push({ start, end });
    k = end + 1;
  }

  const lines = [];
  let shown = 0;
  let truncated = false;
  for (const h of hunks) {
    const seg = ops.slice(h.start, h.end + 1);
    const aStart = (seg.find((o) => o.aLine)?.aLine ?? 1);
    const bStart = (seg.find((o) => o.bLine)?.bLine ?? 1);
    lines.push(`@@ -${aStart} +${bStart} @@`);
    for (const op of seg) {
      const mark = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
      lines.push(mark + op.line);
      if (op.type !== 'same') shown++;
    }
    if (shown > maxTotal) { truncated = true; break; }
  }
  let text = lines.join('\n');
  if (truncated) text += `\n… diff сокращён (показано ${shown} строк изменений)`;
  return text;
}

/** Краткая статистика изменений: добавлено/удалено строк. */
export function diffStat(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return { added: 0, removed: 0, tooBig: true };
  const ops = lcsOps(a, b);
  return {
    added: ops.filter((o) => o.type === 'add').length,
    removed: ops.filter((o) => o.type === 'del').length,
    tooBig: false
  };
}
