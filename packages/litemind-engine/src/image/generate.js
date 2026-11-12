// Image Generation Manager — реальная генерация изображений через
// stable-diffusion.cpp (sd). Одна генерация = один CLI-процесс:
// никаких лишних фоновых сервисов и занятых портов (ТЗ v0.6.1 §3).
//
// Жизненный цикл задания:
//   idle → generating (spawn sd) → сохранение в галерею → idle
// Прогресс разбирается из stderr sd: фазы (loading/sampling/vae) и шаги
// «12/20 - 5.3it/s». Остановка — kill дерева процесса.
//
// Ресурсы (ТЗ v0.6.1 §5):
//   • перед запуском оценивается потребление RAM и вызывается внешний
//     memory-gate (тот же, что у LLM) — при нехватке памяти задание
//     ЧЕСТНО отклоняется с понятным сообщением, а не вешает машину;
//   • одновременная генерация только ОДНА (очередь из 1 задания);
//   • --vae-on-cpu/--clip-on-cpu/--vae-tiling снижают пиковую RAM;
//   • приоритет процесса — ниже обычного (как у llama-server).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { findSdBinary, sdVersion } from './sdbin.js';
import { scanImageModels } from './models.js';
import { applyPriorityToPid } from '../resource/priority.js';

const IS_WIN = process.platform === 'win32';

/** Оценка RAM для генерации (МБ): веса + рабочая память по разрешению. */
export function estimateImageRamMb({ sizeBytes = 0, width = 512, height = 512 } = {}) {
  const weightsMb = Number(sizeBytes) / 1048576;
  const pixels = Math.max(1, Number(width) * Number(height));
  // SD1.5 CPU 512×512 реально занимает ~2.4–2.8 ГБ сверху весов (UNet-активации,
  // CLIP, VAE). Масштабируем по площади, VAE-tiling включён по умолчанию.
  const workMb = 1024 + (pixels / (512 * 512)) * 768;
  return Math.ceil(weightsMb + workMb + 256); // + процесс/фрагментация
}

/** Приведение параметров генерации к безопасным значениям. */
export function sanitizeParams(p = {}) {
  const num = (v, def, min, max) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  const out = {};
  out.prompt = String(p.prompt ?? '').slice(0, 4000);
  out.negative = String(p.negative ?? '').slice(0, 4000);
  out.width = num(p.width, 512, 64, 1024);
  out.height = num(p.height, 512, 64, 1024);
  // Автоснижение разрешения при нехватке памяти решается gate'ом; здесь
  // ограничиваем сверху разумным максимумом низкой спецификации.
  out.steps = num(p.steps, 12, 1, 50);
  out.cfg = Number(p.cfg ?? 7);
  if (!Number.isFinite(out.cfg)) out.cfg = 7;
  out.cfg = Math.min(20, Math.max(1, Math.round(out.cfg * 10) / 10));
  out.seed = Number.isFinite(Number(p.seed)) && Number(p.seed) >= 0
    ? Math.floor(Number(p.seed))
    : -1; // -1 → случайный
  out.threads = num(p.threads, 0, 0, 16); // 0 = авто
  return out;
}

export class ImageGenManager {
  /**
   * @param {{ config: object, log?: object, gallery?: object, gate?: (est:object)=>Promise<{allowed:boolean, reason?:string, severity?:string}> }} deps
   *   gallery — ImageGallery (src/image/gallery.js);
   *   gate — тот же memory-gate, что использует engine для LLM.
   */
  constructor({ config, log = null, gallery = null, gate = null } = {}) {
    this.config = config;
    this.log = log;
    this.gallery = gallery;
    this.gate = gate;
    this.job = null;      // текущее задание { id, state, phase, percent, … }
    this._seq = 0;
    this._proc = null;
    this._waiters = new Set(); // ждущие задания (очередь на 1)
  }

  /** Найденный sd-бинарник + версия (или null). */
  async backendInfo() {
    const bin = findSdBinary(this.config.image);
    const version = await sdVersion(bin);
    return { binary: bin, version, found: Boolean(bin && version) };
  }

  get busy() {
    return Boolean(this.job && this.job.state === 'generating');
  }

  /** Снимок текущего задания для UI. */
  status() {
    return {
      busy: this.busy,
      job: this.job ? {
        id: this.job.id,
        state: this.job.state,
        phase: this.job.phase,
        phaseRu: this.job.phaseRu,
        percent: this.job.percent,
        step: this.job.step,
        stepsTotal: this.job.stepsTotal,
        elapsedMs: Date.now() - this.job.startedAt,
        etaMs: this.job.etaMs ?? null,
        error: this.job.error ?? null,
        params: this.job.params,
        model: this.job.model
      } : null
    };
  }

  /**
   * Начать генерацию. Возвращает снимок задания.
   * Отклоняет 409-подобной ошибкой, если уже идёт генерация, и ошибкой
   * MEMORY_BUDGET, если памяти недостаточно (честно, с подсказкой).
   */
  async generate({ modelFile, modelName, params }) {
    if (this.busy) {
      const e = new Error('Генерация уже выполняется — остановите её или дождитесь завершения.');
      e.code = 'BUSY'; e.status = 409;
      throw e;
    }
    const cfg = this.config.image ?? {};
    const bin = findSdBinary(cfg);
    if (!bin) {
      const e = new Error('Бэкенд генерации изображений (stable-diffusion.cpp) не найден. Переустановите приложение или укажите путь в настройках.');
      e.code = 'SD_NOT_FOUND'; e.status = 500;
      throw e;
    }
    const version = await sdVersion(bin);
    if (!version) {
      const e = new Error('Бэкенд генерации не запускается на этом компьютере (сборка несовместима с процессором). Обратитесь к журналу «Мониторинг».');
      e.code = 'SD_INCOMPATIBLE'; e.status = 500;
      throw e;
    }

    // Модель обязана существовать и пройти проверку формата.
    const models = await scanImageModels(this.imageModelsDir());
    const model = models.find((m) => m.file === modelFile) ?? models.find((m) => m.name === modelName);
    if (!model) {
      const e = new Error('Модель изображений не найдена. Скачайте модель в разделе «Мои модели».');
      e.code = 'MODEL_NOT_FOUND'; e.status = 404;
      throw e;
    }
    if (!model.ok) {
      const e = new Error(`Файл модели повреждён или неполон: ${model.reason ?? 'неизвестная причина'}. Удалите и скачайте заново.`);
      e.code = 'MODEL_BROKEN'; e.status = 400;
      throw e;
    }

    // Memory gate: честная оценка + внешний контроль (как у LLM).
    const threads = params.threads || Math.max(1, Math.min(4, os.cpus().length - 1));
    const estimateMb = estimateImageRamMb({ sizeBytes: model.sizeBytes, width: params.width, height: params.height });
    if (this.gate) {
      const verdict = await this.gate({ estimateMb, what: 'image', model: model.name });
      if (verdict && verdict.allowed === false) {
        const e = new Error(verdict.reason || 'Недостаточно свободной памяти для генерации изображения. Выгрузите чат-модель (Мои модели → Выгрузить) или уменьшите разрешение.');
        e.code = 'MEMORY_BUDGET'; e.status = 503; e.details = verdict;
        throw e;
      }
    }

    // Случайный seed генерируем заранее — он честно отображается в UI
    // и позволяет воспроизвести результат (ТЗ §2: сохранение параметров).
    if (params.seed < 0) params.seed = crypto.randomInt(0, 2147483647);

    // tmp-файл результата — в папке галереи, затем честная регистрация.
    const id = `imgj_${Date.now().toString(36)}_${(++this._seq).toString(36)}`;
    const tmpOut = path.join(this.gallery.dir, `${id}.png`);
    await this.gallery.ensureDir();

    const args = this._buildArgs({ bin: model.file, params, threads, tmpOut });
    const job = {
      id,
      state: 'generating',
      phase: 'load',
      phaseRu: 'Запуск бэкенда',
      percent: 0, step: 0, stepsTotal: params.steps,
      etaMs: null,
      startedAt: Date.now(),
      params: { ...params, threads },
      model: model.name,
      modelFile: model.file,
      estimateMb,
      tmpOut,
      lastOutAt: Date.now()
    };
    this.job = job;
    this._spawnProc(bin, args);
    return this.status();
  }

  _buildArgs({ bin: modelPath, params, threads, tmpOut }) {
    const args = [
      '-m', modelPath,
      '-p', params.prompt || ' ',
      '--width', String(params.width),
      '--height', String(params.height),
      '--steps', String(params.steps),
      '--cfg-scale', String(params.cfg),
      '--threads', String(threads),
      '--output', tmpOut
    ];
    args.push('--seed', String(params.seed));
    if (params.negative) args.push('-n', params.negative);
    const cfg = this.config.image ?? {};
    // Экономия RAM на слабых ПК (можно отключить в config.image).
    if (cfg.vaeOnCpu !== false) args.push('--vae-on-cpu');
    if (cfg.clipOnCpu !== false) args.push('--clip-on-cpu');
    if (cfg.vaeTiling !== false) args.push('--vae-tiling');
    if (cfg.diffusionFa !== false) args.push('--fa');
    return args;
  }

  _spawnProc(bin, args) {
    const job = this.job;
    let proc;
    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      job.state = 'error';
      job.error = `Не удалось запустить sd: ${err.message}`;
      return;
    }
    this._proc = proc;
    applyPriorityToPid(proc.pid, 'low').catch(() => { });

    const feed = (chunk) => {
      const text = chunk.toString();
      job.lastOutAt = Date.now();
      this._parseProgress(text, job);
    };
    proc.stdout?.on('data', feed);
    proc.stderr?.on('data', feed);

    proc.on('error', (err) => {
      job.state = 'error';
      job.error = `Бэкенд генерации упал: ${err.message}`;
      this._proc = null;
    });

    proc.on('close', async (code, signal) => {
      this._proc = null;
      job.finishedAt = Date.now();
      job.durationMs = job.finishedAt - job.startedAt;
      if (job.state === 'stopping') {
        job.state = 'stopped';
        job.phaseRu = 'Остановлено пользователем';
        await fs.promises.unlink(job.tmpOut).catch(() => { });
      } else if (code === 0 && job.state !== 'error') {
        // Проверяем, что PNG реально создан и не пуст (честный результат).
        try {
          const st = await fs.promises.stat(job.tmpOut);
          if (st.size < 1024) throw new Error('файл результата подозрительно мал');
          const rec = await this.gallery.accept(job.tmpOut, {
            prompt: job.params.prompt,
            negative: job.params.negative || null,
            model: job.model,
            width: job.params.width,
            height: job.params.height,
            steps: job.params.steps,
            cfg: job.params.cfg,
            seed: job.seedUsed ?? job.params.seed,
            durationMs: job.durationMs
          });
          job.state = 'done';
          job.phaseRu = 'Готово';
          job.percent = 100;
          job.result = { name: rec.name, sizeBytes: rec.sizeBytes, createdAt: rec.createdAt, seed: job.params.seed };
        } catch (err) {
          job.state = 'error';
          job.error = `sd завершился, но результат не сохранён: ${err.message}`;
        }
      } else if (job.state !== 'error') {
        job.state = 'error';
        job.error = `Бэкенд завершился с кодом ${code ?? '—'}${signal ? ` (${signal})` : ''}. См. журнал.`;
      }
      this._flushWaiters();
    });

    // Watchdog: нет вывода дольше idleTimeoutMs → честная ошибка + снятие процесса.
    const cfg = this.config.image ?? {};
    const idleMs = Number(cfg.idleTimeoutMs) || 600000;
    clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      if (!this._proc) return;
      if (Date.now() - this.job.lastOutAt > idleMs) {
        this._logWarn(`sd не выдаёт вывод ${Math.round(idleMs / 60000)} мин — задание снято по таймауту`);
        this.stop().catch(() => { });
      }
    }, 15000);
  }

  _parseProgress(text, job) {
    // Фазы sd.cpp: "loading model", "loading CLIP", "computing the… latent",
    // прогресс-бар " NN/NN - X.XXit/s", "VAE decoding", "saving".
    const low = text.toLowerCase();
    if (low.includes('loading model') || low.includes('loading ckpt')) { job.phase = 'load'; job.phaseRu = 'Загрузка модели'; }
    else if (low.includes('clip')) { job.phase = 'clip'; job.phaseRu = 'Кодирование промпта'; }
    else if (low.includes('vae decode')) { job.phase = 'vae'; job.phaseRu = 'Декодирование VAE'; }
    else if (low.includes('vae')) { job.phase = 'vae'; job.phaseRu = 'Декодирование VAE'; }
    else if (low.includes('sampling') || low.includes('generating')) { job.phase = 'sampling'; job.phaseRu = 'Диффузия'; }
    else if (low.includes('saving')) { job.phase = 'save'; job.phaseRu = 'Сохранение'; }
    const m = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) {
      const step = Number(m[1]);
      const total = Number(m[2]);
      if (total > 0 && step >= 0 && step <= total) {
        job.step = step; job.stepsTotal = total;
        job.percent = Math.round((step / total) * 100);
        const elapsed = Date.now() - job.startedAt;
        if (step > 0) {
          const perStep = elapsed / step;
          job.etaMs = Math.max(0, Math.round(perStep * (total - step)));
        }
      }
    }
  }

  /** Остановка текущей генерации (kill дерева процесса). */
  async stop() {
    if (!this.job || this.job.state !== 'generating') return { stopped: false };
    this.job.state = 'stopping';
    const proc = this._proc;
    if (proc) {
      try {
        if (IS_WIN) {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else {
          proc.kill('SIGTERM');
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* уже мёртв */ } }, 3000);
        }
      } catch { /* процесс уже завершён */ }
    }
    return { stopped: true };
  }

  imageModelsDir() {
    const cfg = this.config.image ?? {};
    if (cfg.modelsDir) return cfg.modelsDir;
    return path.join(this.config.models.rootDir, 'image');
  }

  /** Сканирование моделей изображений (прокси наружу). */
  async listModels() {
    return scanImageModels(this.imageModelsDir());
  }

  _flushWaiters() { for (const w of this._waiters) w(); this._waiters.clear(); }
  _logWarn(msg) { try { this.log?.warn?.(msg); } catch { /* без логгера */ } }

  /** Корректное завершение при закрытии приложения (ТЗ v0.6.1 §3). */
  async shutdown() {
    clearInterval(this._watchdog);
    await this.stop().catch(() => { });
    // ждём до 5 с фактического завершения
    for (let i = 0; i < 50 && this.busy; i++) await new Promise((r) => setTimeout(r, 100));
  }
}
