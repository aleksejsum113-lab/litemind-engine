// LiteMind Engine — безопасный вычислитель математических выражений (ТЗ v0.6.4 §4).
//
// Маленькая модель не обязана сама умножать 8-значные числа — компьютер делает
// это точно (ТЗ дополнение §4: «математика → проверенный вычислительный инструмент»).
// Реализация без eval: токенайзер + shunting-yard (алгоритм сортировочной станции).
// Разрешены: числа, + - * / % ^ ( ), унарный минус, функции sqrt/sin/cos/tan/abs/
// round/floor/ceil/log/log10/exp, константы pi/e. Всё остальное — честный отказ.

const FUNCS = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp
};

const PRECEDENCE = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3, 'u-': 4 };

/** Токенайзер: числа (десятичные), идентификаторы, операторы, скобки, запятые-аргументы. */
export function tokenize(expr) {
  const s = String(expr ?? '').replace(/,/g, '.').replace(/\s+/g, ' ');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = s.slice(i, j);
      if ((num.match(/\./g) ?? []).length > 1) throw new Error(`некорректное число «${num}»`);
      tokens.push({ t: 'num', v: Number(num) });
      i = j;
      continue;
    }
    if (/[a-zA-Zа-яА-Я_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Zа-яА-Я_0-9]/.test(s[j])) j++;
      tokens.push({ t: 'id', v: s.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ('+-*/%^()'.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error(`недопустимый символ «${c}» в выражении`);
  }
  return tokens;
}

/** Вычислить выражение. Бросает Error с понятным текстом при любой проблеме. */
export function evaluateExpression(input) {
  const tokens = tokenize(input);
  if (!tokens.length) throw new Error('пустое выражение');

  const output = [];
  const ops = [];
  let prevType = null; // 'num' | 'op' | 'lparen' | 'rparen'

  const popOp = () => {
    const op = ops.pop();
    if (!op) throw new Error('несогласованное выражение');
    if (op.v === 'u-') {
      const a = output.pop();
      if (a === undefined) throw new Error('несогласованное выражение');
      output.push(-a);
      return;
    }
    if (op.fn) {
      const argCount = op.fn === 1 ? 1 : op.fn;
      const args = [];
      for (let k = 0; k < argCount; k++) {
        const v = output.pop();
        if (v === undefined) throw new Error('несогласованное выражение');
        args.unshift(v);
      }
      const f = FUNCS[op.v];
      const r = f(...args);
      if (!Number.isFinite(r)) throw new Error(`функция ${op.v} вернула нечисловой результат`);
      output.push(r);
      return;
    }
    const b = output.pop();
    const a = output.pop();
    if (a === undefined || b === undefined) throw new Error('несогласованное выражение');
    let r;
    switch (op.v) {
      case '+': r = a + b; break;
      case '-': r = a - b; break;
      case '*': r = a * b; break;
      case '/':
        if (b === 0) throw new Error('деление на ноль');
        r = a / b;
        break;
      case '%':
        if (b === 0) throw new Error('деление на ноль');
        r = a % b;
        break;
      case '^': r = a ** b; break;
      default: throw new Error(`неизвестная операция «${op.v}»`);
    }
    if (!Number.isFinite(r)) throw new Error('результат вне допустимого диапазона');
    output.push(r);
  };

  for (const tok of tokens) {
    if (tok.t === 'num') {
      output.push(tok.v);
      prevType = 'num';
      continue;
    }
    if (tok.t === 'id') {
      if (tok.v === 'pi') { output.push(Math.PI); prevType = 'num'; continue; }
      if (tok.v === 'e') { output.push(Math.E); prevType = 'num'; continue; }
      if (!FUNCS[tok.v]) throw new Error(`неизвестное имя «${tok.v}» (доступные функции: ${Object.keys(FUNCS).join(', ')}, pi, e)`);
      ops.push({ v: tok.v, fn: 1 });
      prevType = 'fn';
      continue;
    }
    // оператор или скобка
    const v = tok.v;
    if (v === '(') {
      ops.push({ v: '(' });
      prevType = 'lparen';
      continue;
    }
    if (v === ')') {
      while (ops.length && ops[ops.length - 1].v !== '(') popOp();
      if (!ops.length) throw new Error('несогласованные скобки');
      ops.pop(); // снять '('
      prevType = 'rparen';
      continue;
    }
    // бинарный/унарный минус и прочие операторы
    let op = v;
    if (v === '-' && (prevType === null || prevType === 'op' || prevType === 'lparen')) {
      op = 'u-'; // унарный минус
      ops.push({ v: 'u-', u: true });
      prevType = 'op';
      continue;
    }
    if (!'+-*/%^'.includes(op)) throw new Error(`недопустимая операция «${op}»`);
    while (ops.length) {
      const top = ops[ops.length - 1];
      if (top.v === '(') break;
      const topPrec = top.u ? PRECEDENCE['u-'] : (top.fn ? 5 : PRECEDENCE[top.v]);
      const curPrec = PRECEDENCE[op];
      // '^' — правоассоциативный: не выталкиваем равный приоритет
      if (topPrec > curPrec || (topPrec === curPrec && op !== '^')) popOp();
      else break;
    }
    ops.push({ v: op });
    prevType = 'op';
  }
  while (ops.length) {
    if (ops[ops.length - 1].v === '(') throw new Error('несогласованные скобки');
    popOp();
  }
  if (output.length !== 1) throw new Error('несогласованное выражение');
  const result = output[0];
  if (!Number.isFinite(result)) throw new Error('результат не является конечным числом');
  // Число 2^53+ теряет точность — честно округляем до читаемого вида.
  return Math.abs(result) < 1e15 ? Math.round(result * 1e10) / 1e10 : result;
}

/**
 * Найти и вычислить математическое подвыражение в тексте запроса
 * («сколько будет 234*7», «(12+5)/2»). Возвращает { expression, result } или null.
 */
export function findMathExpression(text) {
  const s = String(text ?? '');
  // Кандидат: самая длинная подстрока из цифр/операторов/скобок/точек/разрешённых имён.
  const m = s.match(/((?:сколько будет|вычисли|посчитай|calculate|compute|=)\s*)?([\d(][\d\s+\-*/^%().,eEpiусsqrtincosabslgdflxexpе]{0,120}[\d)%]|[\d.]+\s*[*/^+-]\s*[\d.]+)/i);
  if (!m) return null;
  const candidate = m[2].trim();
  if (!/\d/.test(candidate)) return null;
  // Должен содержать оператор или быть явным числом в ответ на «сколько будет».
  if (!/[+\-*/^%]/.test(candidate) && !m[1]) return null;
  try {
    const result = evaluateExpression(candidate);
    return { expression: candidate.replace(/\s+/g, ' '), result };
  } catch {
    return null;
  }
}
