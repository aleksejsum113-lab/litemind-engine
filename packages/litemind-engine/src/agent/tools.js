// LiteMind Agent — реестр инструментов (Agent → Tool → Result).
// Ноль зависимостей: файловые операции через workspace.js, команды — spawn.
// Все пути строго внутри корня проекта (safeRelPath), мутирующие действия
// требуют подтверждения пользователя (ТЗ AI Agent §Безопасность).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  listTree, grepFiles, findFiles, safeRelPath, makeBackup, decodeBuffer
} from '../project/workspace.js';
import { unifiedDiff, diffStat } from './diff.js';

const MAX_READ_BYTES = 256 * 1024;      // read_file: до 256 КБ файла
const MAX_READ_CHARS = 32_000;          // ...но в диалог не больше 32К символов
const MAX_TREE_ENTRIES = 300;
const MAX_GREP_HITS = 40;
const MAX_OUTPUT_CHARS = 8_000;         // результат инструмента в диалоге
const TERM_TIMEOUT_MS_DEFAULT = 120_000;
const TERM_TIMEOUT_MS_MAX = 300_000;
const TERM_OUTPUT_BYTES = 1024 * 1024;

/** Есть ли файлы/папки вне корня в путях — отсекается safeRelPath; здесь — косметика. */
const rel = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/** Схемы инструментов для системного промпта (компактный JSON). */
const TOOL_SPECS = [
  { name: 'list_files', args: { dir: '(опц.) подпапка проекта' }, desc: 'Показать файлы и папки проекта (или подпапки).' },
  { name: 'read_file', args: { path: 'относительный путь файла' }, desc: 'Прочитать текст файла.' },
  { name: 'write_file', args: { path: 'путь', content: 'полное новое содержимое' }, desc: 'Создать или перезаписать файл. Требует подтверждения пользователя.' },
  { name: 'edit_file', args: { path: 'путь', find: 'точный текст для замены', replace: 'новый текст', all: '(опц.) заменить все вхождения' }, desc: 'Заменить фрагмент в файле. Требует подтверждения.' },
  { name: 'delete_file', args: { path: 'путь' }, desc: 'Удалить файл. Требует подтверждения.' },
  { name: 'search', args: { query: 'текст или регулярка', is_regex: '(опц.) true/false' }, desc: 'Найти текст в файлах проекта (grep).' },
  { name: 'terminal', args: { command: 'команда', timeout_sec: '(опц.) 1..300' }, desc: 'Выполнить команду в папке проекта. Требует подтверждения.' },
  { name: 'weather', args: { place: 'город, напр. Иркутск' }, desc: 'Текущая погода из открытого сервиса Open-Meteo (нужен включённый интернет).' },
  { name: 'web_search', args: { query: 'поисковый запрос' }, desc: 'Поиск в интернете через DuckDuckGo (нужен включённый интернет).' },
  { name: 'calculator', args: { expression: 'математическое выражение, напр. 234*7' }, desc: 'Точно вычислить математическое выражение.' },
  { name: 'memory_save', args: { text: 'факт для долговременной памяти' }, desc: 'Сохранить факт в память помощника.' },
  { name: 'memory_search', args: { query: 'что найти в памяти' }, desc: 'Найти сохранённые факты пользователя.' },
  { name: 'task_create', args: { text: 'что сделать', due_at: '(опц.) ISO-дата напоминания', repeat: '(опц.) none|daily|weekdays|weekly' }, desc: 'Создать задачу/напоминание в планировщике LiteMind.' },
  { name: 'task_list', args: {}, desc: 'Показать активные задачи пользователя.' },
  { name: 'screen_look', args: {}, desc: 'Прочитать текст с экрана пользователя (только в Desktop с включённым разрешением).' },
  { name: 'ask_user', args: { question: 'вопрос' }, desc: 'Задать пользователю вопрос и дождаться ответа в диалоге.' },
  { name: 'done', args: { summary: 'итог для пользователя', created: ['созданные файлы'], modified: ['изменённые файлы'], failed: ['что не удалось'] }, desc: 'Завершить задачу с итоговым отчётом.' }
];

/** Инструменты, которым НЕ нужен открытый проект (сервисные). */
const NON_PROJECT_TOOLS = new Set([
  'weather', 'web_search', 'calculator', 'memory_save', 'memory_search',
  'task_create', 'task_list', 'screen_look', 'web_fetch', 'github', 'ask_user', 'done'
]);

/** Спецификация для системного промпта: одна строка на инструмент. */
export function toolsPromptLine() {
  return TOOL_SPECS.map((t) => `${t.name}(${Object.keys(t.args).join(', ')}) — ${t.desc}`).join('\n');
}

/** Открытый текст опасных паттернов команд (для предупреждения в UI, не для блокировки). */
export function isRiskyCommand(cmd) {
  return /(\brm\s+-[rf]|del\s+\/|rmdir|rd\s+\/s|format\s|mkfs|shutdown|taskkill|reg\s+(add|delete)|setx|curl.*\|\s*(sh|bash|powershell)|Invoke-Expression|iex\s|Remove-Item.*-Recurse)/i.test(String(cmd || ''));
}

/** Урезание результата инструмента до компактного вида для диалога. */
function cap(text, limit = MAX_OUTPUT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n… (сокращено, всего ${s.length} символов)`;
}

/** Выполнение команды: spawn shell в cwd, таймаут, декодер CP866/1251/UTF-8, kill дерева.
 *  onStart(pid, kill) — даёт сессии агента шанс убить команду при остановке задачи. */
export function execCommand(command, cwd, { timeoutMs = TERM_TIMEOUT_MS_DEFAULT, maxBytes = TERM_OUTPUT_BYTES, onStart = null } = {}) {
  timeoutMs = Math.max(1_000, Math.min(TERM_TIMEOUT_MS_MAX, Number(timeoutMs) || TERM_TIMEOUT_MS_DEFAULT));
  return new Promise((resolve) => {
    const startAt = Date.now();
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = spawn(shell, shellArgs, { cwd, windowsHide: true, detached: process.platform !== 'win32' });
    const killTree = () => {
      try {
        if (process.platform === 'win32') { if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      } catch { try { child.kill('SIGKILL'); } catch { /* уже мёртв */ } }
    };
    if (typeof onStart === 'function') { try { onStart(child.pid, killTree); } catch { /* */ } }
    let out = Buffer.alloc(0);
    let truncated = false;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      killTree();
    }, timeoutMs);

    const collect = (chunk) => {
      if (out.length >= maxBytes) { truncated = true; return; }
      out = out.length + chunk.length > maxBytes ? Buffer.concat([out, chunk.subarray(0, maxBytes - out.length)]) : Buffer.concat([out, chunk]);
      if (out.length >= maxBytes) truncated = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: '', stderr: String(err.message), truncated: false, timedOut: false, durationMs: 0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const { text } = decodeBuffer(out);
      resolve({
        exitCode: code,
        stdout: text,
        stderr: '',
        truncated,
        timedOut: killed,
        durationMs: Date.now() - startAt
      });
    });
  });
}

/**
 * Реестр инструментов агента. Каждый execute возвращает:
 *   { ok, result, needsConfirmation?, change? , report? }
 * change = { tool, args, diff, stat, backupId? } — показывается пользователю.
 */
export function createToolRegistry({ config, logger } = {}) {
  const cfgPath = config?.paths?.configPath ?? null;

  /** Чтение файла (без подтверждения). */
  async function readFile(root, relPath) {
    const { file, rel: clean } = safeRelPath(root, relPath);
    const st = await fsp.stat(file); // ENOENT → ошибка наружу
    if (st.isDirectory()) throw new Error(`«${clean}» — это папка, нужен файл`);
    if (st.size > MAX_READ_BYTES) {
      const fh = await fsp.open(file, 'r');
      try {
        const buf = Buffer.alloc(MAX_READ_BYTES);
        await fh.read(buf, 0, MAX_READ_BYTES, 0);
        return cap(`[файл ${clean}: показаны первые ${MAX_READ_BYTES} из ${st.size} байт]\n` + buf.toString('utf8'));
      } finally { await fh.close(); }
    }
    const text = await fsp.readFile(file, 'utf8');
    return cap(text);
  }

  /** Подготовка записи/правки: diff + бэкап (без записи). */
  async function prepareWrite(root, relPath, nextContent) {
    const { file, rel: clean } = safeRelPath(root, relPath);
    let old = null;
    try { old = await fsp.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const stat = diffStat(old ?? '', nextContent);
    if (old !== null && old === nextContent) return { noop: true, rel: clean };
    const backup = old !== null ? await makeBackup(root, clean, { configPath: cfgPath }) : null;
    return {
      noop: false,
      rel: clean,
      change: {
        tool: 'write_file',
        path: clean,
        isNew: old === null,
        diff: unifiedDiff(old ?? '', nextContent),
        stat,
        backupId: backup?.backupId ?? null
      },
      apply: async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, nextContent, 'utf8');
        return { ok: true, result: `файл записан: ${clean} (${Buffer.byteLength(nextContent, 'utf8')} байт)${backup ? `, резервная копия: ${backup.backupId}` : ', файл новый'}` };
      }
    };
  }

  /** Подготовка правки find/replace (без записи). */
  async function prepareEdit(root, relPath, find, replaceTo, all) {
    if (!find) throw new Error('edit_file: нужен непустой find');
    const { file, rel: clean } = safeRelPath(root, relPath);
    const old = await fsp.readFile(file, 'utf8'); // ENOENT → ошибка наружу
    const occurrences = old.split(find).length - 1;
    if (occurrences === 0) return { noop: true, rel: clean, note: 'фрагмент find не найден в файле' };
    let next;
    if (all || occurrences === 1) next = old.split(find).join(replaceTo);
    else {
      const idx = old.indexOf(find);
      next = old.slice(0, idx) + replaceTo + old.slice(idx + find.length);
    }
    const backup = await makeBackup(root, clean, { configPath: cfgPath });
    return {
      noop: false,
      rel: clean,
      change: {
        tool: 'edit_file',
        path: clean,
        isNew: false,
        diff: unifiedDiff(old, next),
        stat: diffStat(old, next),
        backupId: backup.backupId
      },
      apply: async () => {
        await fsp.writeFile(file, next, 'utf8');
        return { ok: true, result: `файл изменён: ${clean} (${occurrences === 1 ? '1 вхождение' : `${all ? 'все' : 'первое из'} ${occurrences} вхождений`}), резервная копия: ${backup.backupId}` };
      }
    };
  }

  /** Подготовка удаления (без удаления). */
  async function prepareDelete(root, relPath) {
    const { file, rel: clean } = safeRelPath(root, relPath);
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new Error('delete_file: удаление папок не поддерживается (только файлы)');
    const backup = await makeBackup(root, clean, { configPath: cfgPath });
    return {
      noop: false,
      rel: clean,
      change: {
        tool: 'delete_file',
        path: clean,
        isNew: false,
        diff: `файл будет удалён: ${clean} (${st.size} байт)\nрезервная копия: ${backup.backupId}`,
        stat: { added: 0, removed: 1, tooBig: false },
        backupId: backup.backupId
      },
      apply: async () => {
        await fsp.unlink(file);
        return { ok: true, result: `файл удалён: ${clean} (копия для восстановления: ${backup.backupId})` };
      }
    };
  }

  return {
    /** Список имён (для валидации ACTION от модели). */
    names: () => TOOL_SPECS.map((t) => t.name),

    /** Мутирующие инструменты, требующие подтверждения. */
    requiresConfirmation: (name) => ['write_file', 'edit_file', 'delete_file', 'terminal'].includes(name),

    /**
     * Выполнить инструмент. ctx = { projectRoot, internet }.
     * Для мутирующих — возвращает change + apply (запись выполняет сессия ПОСЛЕ подтверждения).
     */
    async execute(name, args, ctx) {
      args = args && typeof args === 'object' ? args : {};
      const root = ctx?.projectRoot ?? null;
      // Сервисные инструменты не требуют открытого проекта.
      if (!NON_PROJECT_TOOLS.has(name) && !root) {
        throw new Error('не выбран проект (workspace) — работа с файлами невозможна');
      }
      const services = ctx?.services ?? {}; // { memory, tasks, intelligence, web }

      switch (name) {
        case 'list_files': {
          // v0.6.1: listTree возвращает {dirs, files, skipped, truncated, totalEntries},
          // а не массив — прежний tree.map() падал с TypeError на каждом вызове.
          const dir = rel(args.dir);
          const t = await listTree(root, dir, { limit: MAX_TREE_ENTRIES });
          const lines = [
            ...(t.dirs ?? []).map((e) => `📁 ${e.rel}/`),
            ...(t.files ?? []).map((e) => `📄 ${e.rel}${e.sizeBytes != null ? ` (${e.sizeBytes} б)` : ''}`)
          ];
          if (t.truncated) lines.push(`… показаны первые ${t.dirs.length + t.files.length} из ${t.totalEntries} записей`);
          if (t.skipped?.length) lines.push(`(скрыто: ${t.skipped.join(', ')})`);
          return { ok: true, result: cap(lines.join('\n') || '(пусто)') };
        }

        case 'read_file':
          return { ok: true, result: await readFile(root, rel(args.path)) };

        case 'search': {
          const q = String(args.query ?? '');
          if (!q) throw new Error('search: нужен query');
          const isRe = args.is_regex === true;
          if (isRe) {
            // валидация регулярки заранее, чтобы ошибка ушла модели, а не уронила цикл
            // eslint-disable-next-line no-new
            new RegExp(q);
          }
          const hits = await grepFiles(root, q, { limit: MAX_GREP_HITS, caseSensitive: false });
          const lines = [];
          for (const h of hits) {
            lines.push(`${h.path}:`);
            for (const m of h.matches ?? []) lines.push(`  ${m.line}: ${String(m.text).slice(0, 200)}`);
          }
          return { ok: true, result: cap(lines.length ? lines.join('\n') : 'совпадений не найдено') };
        }

        case 'find_files': {
          const found = await findFiles(root, String(args.query ?? ''), { limit: 50 });
          return { ok: true, result: cap(found.map((f) => f.path).join('\n') || 'не найдено') };
        }

        case 'write_file': {
          if (typeof args.content !== 'string') throw new Error('write_file: content должен быть строкой');
          const prep = await prepareWrite(root, rel(args.path), args.content);
          if (prep.noop) return { ok: true, result: `файл ${prep.rel} уже имеет такое содержимое — изменений нет` };
          return { ok: true, needsConfirmation: true, change: prep.change, _apply: prep.apply };
        }

        case 'edit_file': {
          const prep = await prepareEdit(root, rel(args.path), String(args.find ?? ''), String(args.replace ?? ''), args.all === true);
          if (prep.noop) return { ok: true, result: `в ${prep.rel}: ${prep.note ?? 'изменений нет'}` };
          return { ok: true, needsConfirmation: true, change: prep.change, _apply: prep.apply };
        }

        case 'delete_file': {
          const prep = await prepareDelete(root, rel(args.path));
          return { ok: true, needsConfirmation: true, change: prep.change, _apply: prep.apply };
        }

        case 'terminal': {
          const command = String(args.command ?? '').trim();
          if (!command) throw new Error('terminal: нужна команда');
          const timeoutSec = Number(args.timeout_sec);
          return {
            ok: true,
            needsConfirmation: true,
            change: {
              tool: 'terminal',
              path: '.',
              isNew: false,
              diff: `команда: ${command}\nпапка: ${root}\nтаймаут: ${Math.min(300, Math.max(1, Number.isFinite(timeoutSec) ? timeoutSec : 120))} с${isRiskyCommand(command) ? '\n⚠️ похоже на опасную команду' : ''}`,
              stat: { added: 0, removed: 0, tooBig: false },
              backupId: null
            },
            _apply: async () => {
              const r = await execCommand(command, root, {
                timeoutMs: (Number.isFinite(timeoutSec) ? timeoutSec : 120) * 1000,
                onStart: ctx?.onTermStart
              });
              const head = `код завершения: ${r.exitCode}${r.timedOut ? ' (превышен таймаут, процесс остановлен)' : ''}`;
              const body = r.stdout ? cap(r.stdout) : '(stdout пуст)';
              const err = r.stderr ? `\nstderr: ${cap(r.stderr, 2000)}` : '';
              return { ok: r.exitCode === 0, result: `${head}\n${body}${err}` };
            }
          };
        }

        case 'web_fetch': {
          if (!ctx?.web?.enabled) throw new Error('доступ к интернету выключен (Настройки → Интернет)');
          const r = await ctx.web.fetchText(String(args.url ?? ''));
          return { ok: true, result: cap(r.text, 20_000) };
        }

        case 'github': {
          if (!ctx?.web?.enabled) throw new Error('доступ к интернету выключен (Настройки → Интернет)');
          const r = await ctx.web.github(args);
          return { ok: true, result: cap(r.text, 20_000) };
        }

        // ── ТЗ v0.6.4: сервисные инструменты компаньона ────────────────────

        case 'weather': {
          const place = String(args.place ?? '').trim();
          if (!place) throw new Error('weather: нужен place (город)');
          if (!ctx?.web?.enabled) throw new Error('доступ к интернету выключен (Настройки → Интернет) — актуальную погоду проверить нельзя');
          const { currentWeather } = await import('../web/weather.js');
          const w = await currentWeather(place, { fetchImpl: ctx?.fetchImpl ?? fetch });
          return { ok: true, result: cap(`${w.summary} Время наблюдения (местное): ${w.observedAt}. Источник: Open-Meteo (${w.source}). Сообщи пользователю эти данные с указанием источника и времени.`, 4000) };
        }

        case 'web_search': {
          const q = String(args.query ?? '').trim();
          if (!q) throw new Error('web_search: нужен query');
          if (!ctx?.web?.enabled) throw new Error('доступ к интернету выключен (Настройки → Интернет)');
          const { webSearch, fetchSearchPages } = await import('../web/search.js');
          const found = await webSearch(q, { fetchImpl: ctx?.fetchImpl ?? fetch });
          const pages = await fetchSearchPages(found.results.slice(0, 3), { fetchText: (u) => ctx.web.fetchText(u), perPageChars: 2000 });
          const lines = [`Поиск (${found.engine}), получено ${found.fetchedAt}:`];
          found.results.slice(0, 6).forEach((r, i) => lines.push(`${i + 1}. ${r.title} — ${r.url}`));
          for (const p of pages.filter((x) => x.ok)) lines.push(`--- ${p.url} ---\n${cap(p.text, 2000)}`);
          return { ok: true, result: cap(lines.join('\n'), 20_000) };
        }

        case 'calculator': {
          const expr = String(args.expression ?? '').trim();
          if (!expr) throw new Error('calculator: нужен expression');
          const { evaluateExpression } = await import('../intelligence/calculator.js');
          const result = evaluateExpression(expr);
          return { ok: true, result: `${expr} = ${result}` };
        }

        case 'memory_save': {
          const text = String(args.text ?? '').trim();
          if (!text) throw new Error('memory_save: нужен text');
          if (!services.memory) throw new Error('память недоступна');
          const r = services.memory.add({ text, source: 'assistant' });
          return { ok: true, result: `сохранено в память: «${String(r.entry.text).slice(0, 120)}»` };
        }

        case 'memory_search': {
          const q = String(args.query ?? '').trim();
          if (!services.memory) throw new Error('память недоступна');
          const hits = services.memory.search(q, { limit: 8 });
          return { ok: true, result: hits.length ? hits.map((e) => `- ${String(e.text).slice(0, 160)}`).join('\n') : 'в памяти ничего не найдено' };
        }

        case 'task_create': {
          const text = String(args.text ?? '').trim();
          if (!text) throw new Error('task_create: нужен text');
          if (!services.tasks) throw new Error('планировщик недоступен');
          const t = services.tasks.add({ text, dueAt: args.due_at ?? null, repeat: ['none', 'daily', 'weekdays', 'weekly'].includes(args.repeat) ? args.repeat : 'none', source: 'agent' });
          return { ok: true, result: `задача создана: «${t.text.slice(0, 120)}»${t.dueAt ? `, напоминание: ${t.dueAt}` : ', без напоминания'}` };
        }

        case 'task_list': {
          if (!services.tasks) throw new Error('планировщик недоступен');
          const list = services.tasks.list({ includeDone: false });
          return { ok: true, result: list.length ? list.map((t) => `- ${t.text}${t.dueAt ? ` (напоминание: ${t.dueAt}, повтор: ${t.repeat})` : ''}`).join('\n') : 'активных задач нет' };
        }

        case 'screen_look': {
          const host = services.intelligence?.host?.();
          if (!host || typeof host.captureScreenText !== 'function') {
            return { ok: false, result: 'просмотр экрана доступен только в LiteMind Desktop с включённым разрешением (Компаньон → Разрешения). Не притворяйся, что видишь экран.' };
          }
          const r = await host.captureScreenText({});
          if (!r?.ok) return { ok: false, result: `экран прочитать не удалось: ${r?.error ?? 'неизвестная ошибка'}` };
          return { ok: true, result: `Текст с экрана (получено ${r.retrievedAt}):\n${cap(r.text, 4000)}` };
        }

        default:
          throw new Error(`неизвестный инструмент: ${name}`);
      }
    }
  };
}
