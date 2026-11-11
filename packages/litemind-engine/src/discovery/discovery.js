// Model Discovery — менеджер автоматического обнаружения моделей
// (ТЗ v0.6.2 «LiteMind Model Discovery & Auto Catalog»).
//
// Принципы:
//  • Только метаданные. Веса моделей НЕ скачиваются без команды пользователя
//    (§5/§9): за загрузку отвечает существующий DownloadManager.
//  • Никакой параллельной системы: совместимость считается существующим
//    compat.rateCatalogModel по реальному железу (§10), скачивание — тем же
//    загрузчиком с проверкой SHA-256, папка моделей — config.models.rootDir.
//  • Сбой сети не ломает приложение: каталог остаётся прежним, ошибка
//    фиксируется в lastError и показывается в UI (§5/§11.10).
//  • Автопроверка раз в intervalHours (по умолчанию 24) + кнопка
//    «Проверить новые модели». Проверка лёгкая: ~9 HTTP-запросов метаданных
//    + дерево файлов только для новых/изменившихся репозиториев (с лимитом).

import path from 'node:path';
import fs from 'node:fs';
import { DiscoveryCatalog } from './catalog.js';
import { searchHuggingFaceGguf, listRepoGgufFiles, DEFAULT_GGUF_AUTHORS } from './sources.js';
import {
  familyFromName,
  quantFromFileName,
  paramsFromName,
  purposesFromName,
  speedClassOf,
  isModelGgufFile,
  detectFlavor,
  describeEntry
} from './heuristics.js';
import { checkDownloadUrl, safeGgufName, safeTargetDir } from '../storage/storage.js';
import * as compat from '../compat.js';
import * as hardware from '../diagnostics/hardware.js';

const TREE_CONCURRENCY = 3;
const MAX_CATALOG_ENTRIES = 1500;

export class DiscoveryManager {
  /**
   * @param opts.downloads      существующий DownloadManager (общий с UI)
   * @param opts.fetchImpl      для тестов (мок вместо сети)
   * @param opts.hardwareProvider  для тестов (синтетическое железо)
   */
  constructor({ config, logger = null, downloads = null, fetchImpl = fetch, hardwareProvider = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.downloads = downloads;
    this.hardwareProvider = hardwareProvider ?? (() => hardware.analyzeHardware({
      candidateRoots: [path.parse(path.resolve(config.models.rootDir)).root]
    }));
    const dir = path.join(path.dirname(config.paths.configPath), 'discovery');
    this.catalog = new DiscoveryCatalog({ dir, logger }).load();
    this.checking = false;
    this._timers = [];
    this._stop = false;
  }

  get cfg() {
    const d = this.config.discovery ?? {};
    return {
      enabled: d.enabled !== false,
      intervalHours: clampInt(d.intervalHours ?? 24, 6, 168, 24),
      maxTreeFetches: clampInt(d.maxTreeFetchesPerCheck ?? 25, 5, 80, 25),
      authors: Array.isArray(d.authors) && d.authors.length ? d.authors : DEFAULT_GGUF_AUTHORS
    };
  }

  /** Планировщик: догоняющая проверка при старте + почасовой тикер (§5). */
  schedule() {
    if (this._timers.length) return;
    // Через 45 с после старта: если проверка просрочена — делаем тихо в фоне.
    const initial = setTimeout(() => {
      if (this._stop || !this.cfg.enabled) return;
      const last = this.catalog.data.lastCheckAt ? Date.parse(this.catalog.data.lastCheckAt) : 0;
      if (Date.now() - last >= this.cfg.intervalHours * 3600000) {
        this.refresh().catch(() => {});
      }
    }, 45000);
    initial.unref?.();
    this._timers.push(initial);
    // Часовой тикер — проверяет срок очередного автопробега.
    const tick = setInterval(() => {
      if (this._stop || !this.cfg.enabled || this.checking) return;
      const last = this.catalog.data.lastCheckAt ? Date.parse(this.catalog.data.lastCheckAt) : 0;
      if (Date.now() - last >= this.cfg.intervalHours * 3600000) {
        this.refresh().catch(() => {});
      }
    }, 3600000);
    tick.unref?.();
    this._timers.push(tick);
  }

  stopTimers() {
    this._stop = true;
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }

  /** Статус для UI: время последней проверки, счётчики, ошибки (§5/§6). */
  status() {
    const entries = Object.values(this.catalog.data.entries);
    const counts = {
      total: entries.length,
      new: entries.filter((e) => this.catalog.displayState(e) === 'new').length,
      updated: entries.filter((e) => this.catalog.displayState(e) === 'updated').length
    };
    const last = this.catalog.data.lastCheckAt ? Date.parse(this.catalog.data.lastCheckAt) : 0;
    const enabled = this.cfg.enabled;
    return {
      enabled,
      intervalHours: this.cfg.intervalHours,
      checking: this.checking,
      lastCheckAt: this.catalog.data.lastCheckAt,
      lastSuccessAt: this.catalog.data.lastSuccessAt,
      lastError: this.catalog.data.lastError,
      lastRun: this.catalog.data.lastRun ?? null,
      nextCheckAt: enabled && last ? new Date(last + this.cfg.intervalHours * 3600000).toISOString() : null,
      counts
    };
  }

  /**
   * Одна проверка источников (§4): поиск → отбор → дерево файлов → слияние.
   * @returns {{reposChecked:number, added:number, updated:number, errors:number}}
   */
  async refresh({ force = false } = {}) {
    if (this.checking) return { skipped: true, reason: 'already checking' };
    this.checking = true;
    let added = 0;
    let updated = 0;
    let reposChecked = 0;
    let errors = 0;
    try {
      const repos = await searchHuggingFaceGguf({
        fetchImpl: this.fetchImpl,
        authors: this.cfg.authors,
        logger: this.logger
      });
      if (!repos.length) {
        // Ни один источник не ответил — ошибка обновления, каталог сохраняем.
        this.catalog.markCheck({ ok: false, error: 'Источники моделей недоступны (сеть?). Ранее найденные модели сохранены.' });
        await this.catalog.save();
        return { reposChecked: 0, added: 0, updated: 0, errors: 1 };
      }

      // Отбор репозиториев: приоритет новым, затем изменившимся (§5).
      const knownMaxUpdated = new Map();
      for (const e of Object.values(this.catalog.data.entries)) {
        const cur = knownMaxUpdated.get(e.repo);
        const iso = e.updatedAt ?? null;
        if (iso && (!cur || iso > cur)) knownMaxUpdated.set(e.repo, iso);
      }
      const fresh = repos.filter((r) => !knownMaxUpdated.has(r.repo));
      const changed = repos.filter((r) => {
        const maxIso = knownMaxUpdated.get(r.repo);
        return maxIso && r.lastModified && r.lastModified > maxIso;
      });
      const queue = [...fresh, ...changed].slice(0, this.cfg.maxTreeFetches);

      // Деревья файлов — с малым параллелизмом (§9: не мешать чату).
      let idx = 0;
      const workers = Array.from({ length: Math.min(TREE_CONCURRENCY, queue.length) }, async () => {
        while (idx < queue.length) {
          const repo = queue[idx++];
          let files = [];
          try {
            files = await listRepoGgufFiles({ repo: repo.repo, fetchImpl: this.fetchImpl });
            reposChecked++;
          } catch (err) {
            errors++;
            this.logger?.warn?.('discovery: репозиторий пропущен', { repo: repo.repo, error: err.message });
            continue;
          }
          for (const f of files) {
            if (!isModelGgufFile(f.name)) continue; // mmproj / многочастные — мимо
            const quant = quantFromFileName(f.name);
            const family = familyFromName(repo.repo) ?? familyFromName(f.name);
            const params = paramsFromName(repo.repo) ?? paramsFromName(f.name);
            const flavor = detectFlavor(repo.repo) ?? detectFlavor(f.name);
            const { entry, changed: ch, isNew } = this.catalog.merge({
              repo: repo.repo,
              author: repo.author,
              name: f.name,
              url: f.url,
              sizeBytes: f.sizeBytes,
              sha256: f.sha256,
              quant,
              family,
              flavor,
              params,
              purposes: purposesFromName(repo.repo),
              speedClass: speedClassOf(params),
              license: repo.license,
              description: describeEntry({ family, params, quant, flavor, author: repo.author }),
              createdAt: repo.createdAt,
              updatedAt: repo.lastModified,
              downloads: repo.downloads,
              likes: repo.likes
            });
            if (isNew) added++;
            else if (ch) updated++;
            void entry;
          }
        }
      });
      await Promise.all(workers);

      this._prune();
      // Честная отметка (§11): если ни одно дерево файлов не удалось получить —
      // это НЕ успешная проверка, а сбой сети/источника; каталог сохраняем,
      // ошибку показываем в UI. Частичный успех (часть деревьев получена) —
      // успешная проверка с числом ошибок в статистике.
      const ok = reposChecked > 0 || errors === 0;
      this.catalog.markCheck({
        ok,
        error: ok ? null : `Не удалось получить файлы ни от одного репозитория (в очереди ${queue.length}, ошибок ${errors}). Каталог сохранён.`
      });
      this.catalog.data.lastRun = {
        at: new Date().toISOString(), reposChecked, added, updated, errors,
        reposFound: repos.length, treesQueued: queue.length
      };
      await this.catalog.save();
      this.logger?.info?.('discovery: проверка завершена', { reposChecked, added, updated, errors });
      return { reposChecked, added, updated, errors };
    } finally {
      this.checking = false;
    }
  }

  /** Не даём каталогу расти бесконечно (метаданные лёгкие, но не бесконечные). */
  _prune() {
    const entries = this.catalog.data.entries;
    const keys = Object.keys(entries);
    if (keys.length <= MAX_CATALOG_ENTRIES) return;
    keys
      .sort((a, b) => String(entries[a].updatedAt ?? '').localeCompare(String(entries[b].updatedAt ?? '')))
      .slice(0, keys.length - MAX_CATALOG_ENTRIES)
      .forEach((k) => delete entries[k]);
  }

  /** Рейтинг записи через существующий механизм совместимости (§10). */
  _rate(entry, hw) {
    const model = {
      id: entry.key,
      family: entry.family ?? 'unknown',
      params: entry.params ?? null,
      speed: entry.speedClass ?? speedClassOf(entry.params),
      contextTokens: null,
      files: [{
        name: entry.name,
        url: entry.url,
        sizeBytes: entry.sizeBytes,
        quant: entry.quant,
        sha256: entry.sha256
      }]
    };
    const r = compat.rateCatalogModel(model, hw);
    return {
      level: r.level,
      levelLabel: r.levelLabel,
      levelReasons: r.levelReasons,
      status: r.status,
      estimatedMb: r.files?.[0]?.estimatedMb ?? null,
      fitLabel: r.fitLabel,
      speedNote: r.speedNote,
      hwRequirements: r.hwRequirements
    };
  }

  /** Имена GGUF в папке моделей (верхний уровень) — признак «установлена». */
  async _installedFiles() {
    const out = new Map(); // name(lower) -> sizeBytes
    try {
      const names = await fs.promises.readdir(this.config.models.rootDir);
      for (const n of names) {
        if (!/\.gguf$/i.test(n) || n.endsWith('.part')) continue;
        const st = await fs.promises.stat(path.join(this.config.models.rootDir, n)).catch(() => null);
        out.set(n.toLowerCase(), st?.size ?? 0);
      }
    } catch { /* папки ещё нет — ничего не установлено */ }
    return out;
  }

  _view(entry, installed, hw) {
    const state = this.catalog.displayState(entry);
    const instSize = installed.get(entry.name.toLowerCase());
    const installedOk = instSize !== undefined;
    // Обновление установленной модели (§8): размер файла в источнике
    // отличается от скачанного — предлагаем обновление, ничего не заменяем.
    const updateAvailable = installedOk && !!entry.sizeBytes && instSize !== entry.sizeBytes;
    const rating = this._rate(entry, hw);
    return {
      ...entry,
      state,
      installed: installedOk,
      installedSizeBytes: installedOk ? instSize : null,
      updateAvailable,
      rating
    };
  }

  /** Список с фильтрами UI (§6). filter: all|new|updated|compatible|chat|coding|text|fast|dolphin|installed */
  async list({ filter = 'all', limit = 200 } = {}) {
    const hw = await this.hardwareProvider();
    const installed = await this._installedFiles();
    const all = this.catalog.listSorted({ limit: 600 }).map((e) => this._view(e, installed, hw));

    const byFilter = (m) => {
      switch (filter) {
        case 'new': return m.state === 'new';
        case 'updated': return m.state === 'updated' || m.updateAvailable;
        case 'compatible': return m.rating.level === 'ok' || m.rating.level === 'limited';
        case 'chat': return m.purposes.includes('chat');
        case 'coding': return m.purposes.includes('coding');
        case 'text': return m.purposes.includes('text');
        case 'fast': return m.speedClass === 'fast';
        case 'dolphin': return ['dolphin', 'huihui', 'abliterated', 'uncensored'].includes(m.flavor);
        case 'installed': return m.installed;
        default: return true; // all
      }
    };
    // Порядок: новые сверху, затем по свежести источника.
    const stateRank = { new: 0, updated: 1, known: 2 };
    const models = all.filter(byFilter)
      .sort((a, b) => stateRank[a.state] - stateRank[b.state] || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, limit);

    const counts = {
      total: all.length,
      new: all.filter((m) => m.state === 'new').length,
      updated: all.filter((m) => m.state === 'updated').length,
      compatible: all.filter((m) => m.rating.level === 'ok' || m.rating.level === 'limited').length,
      installed: all.filter((m) => m.installed).length
    };
    return { models, counts, lastCheckAt: this.catalog.data.lastCheckAt, lastError: this.catalog.data.lastError, checking: this.checking };
  }

  /** Карточка модели: запись + прежние версии + полная оценка (§6/§8). */
  async detail(key) {
    const entry = this.catalog.get(key);
    if (!entry) return null;
    const hw = await this.hardwareProvider();
    const installed = await this._installedFiles();
    return this._view(entry, installed, hw);
  }

  /**
   * Скачать запись существующим загрузчиком (§7): те же проверки, что и у
   * каталога (безопасная ссылка, безопасное имя, место на диске), SHA-256
   * эталон берётся из источника (LFS) и проверяется после загрузки.
   */
  async download(key, { targetDir = null, overwrite = false } = {}) {
    const entry = this.catalog.get(key);
    if (!entry) throw Object.assign(new Error('Модель не найдена в каталоге Discovery.'), { status: 404, code: 'NOT_FOUND' });
    const urlCheck = checkDownloadUrl(entry.url);
    if (!urlCheck.ok) throw Object.assign(new Error(`Ссылка отклонена: ${urlCheck.reason}`), { status: 400, code: 'URL_REJECTED' });
    let name;
    let dir;
    try {
      name = safeGgufName(entry.name);
      dir = safeTargetDir(targetDir || this.config.models.rootDir);
    } catch (err) {
      throw Object.assign(new Error(err.message), { status: 400, code: err.code ?? 'BAD_PATH' });
    }
    const finalPath = path.join(dir, name);
    if (fs.existsSync(finalPath)) {
      const existing = fs.statSync(finalPath).size;
      if (entry.sizeBytes && existing === entry.sizeBytes) {
        return { ok: true, alreadyDownloaded: true, name, targetDir: dir, message: 'Файл уже скачан и имеет правильный размер — повторная загрузка не нужна.' };
      }
      if (!overwrite) {
        throw Object.assign(new Error(`В папке уже есть файл «${name}» (${existing} байт), размер не совпадает с источником. Подтвердите замену.`), { status: 409, code: 'FILE_EXISTS' });
      }
    }
    try {
      const st = fs.statfsSync(dir);
      const need = (entry.sizeBytes ?? 0) + this.config.models.minFreeFraction * st.bsize * st.blocks;
      if (entry.sizeBytes && st.bsize * st.bfree < need) {
        throw Object.assign(new Error('Недостаточно места на выбранном диске (с учётом резерва 5%). Выберите другой диск в Настройках.'), { status: 507, code: 'NO_DISK_SPACE' });
      }
    } catch (err) {
      if (err.code === 'NO_DISK_SPACE') throw err;
      /* каталог ещё не создан — mkdir сделает загрузчик */
    }
    if (!this.downloads) throw Object.assign(new Error('Загрузчик недоступен'), { status: 503, code: 'NO_DOWNLOADER' });
    const job = await this.downloads.start({
      id: `discovery:${key}`,
      url: entry.url,
      name,
      targetDir: dir,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256
    });
    return { ok: true, job };
  }
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
