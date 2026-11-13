// ТЗ v0.6.2 §1 (дополнение): поиск sd.exe в установленном приложении.
// Прогон smoke №2 (run 43389818481): /api/image/status отвечал found=false,
// хотя sd.exe лежит в <установка>\resources\sd\sd.exe — sdCandidates не
// проверял process.resourcesPath (в отличие от lmlama._candidates()).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sdCandidates } from '../src/image/sdbin.js';

const EXE = process.platform === 'win32' ? 'sd.exe' : 'sd';

/** Ставит env/resourcesPath на время fn, затем возвращает исходные значения. */
function withEnv(bin, res, fn) {
  const oldBin = process.env.LITEMIND_SD_BIN;
  const oldRes = process.resourcesPath;
  try {
    if (bin === undefined) delete process.env.LITEMIND_SD_BIN; else process.env.LITEMIND_SD_BIN = bin;
    if (res === undefined) delete process.resourcesPath; else process.resourcesPath = res;
    fn();
  } finally {
    if (oldBin === undefined) delete process.env.LITEMIND_SD_BIN; else process.env.LITEMIND_SD_BIN = oldBin;
    if (oldRes === undefined) delete process.resourcesPath; else process.resourcesPath = oldRes;
  }
}

test('sdCandidates: config → пакет → PATH (вне Electron, без env)', () => {
  withEnv(undefined, undefined, () => {
    const list = sdCandidates({ sdPath: 'D:/custom/sd.exe' });
    assert.equal(list.length, 3, `кандидатов: ${list.join(' | ')}`);
    assert.equal(list[0], 'D:/custom/sd.exe', 'config.image.sdPath — первый');
    assert.ok(list[1].includes(path.join('resources', 'sd')), `пакетный кандидат: ${list[1]}`);
    assert.equal(list[2], EXE, 'последний — поиск по PATH');
  });
});

test('sdCandidates: process.resourcesPath участвует как extraResources установщика', () => {
  withEnv(undefined, 'C:/Users/u/AppData/Local/Programs/ai.litemind.desktop/resources', () => {
    // Внутри Electron process.resourcesPath = <установка>\resources.
    const list = sdCandidates(null);
    assert.equal(list.length, 3, `кандидатов: ${list.join(' | ')}`);
    assert.equal(
      list[0],
      path.join('C:/Users/u/AppData/Local/Programs/ai.litemind.desktop/resources', 'sd', EXE),
      `кандидат extraResources — до пакетного: ${list[0]}`
    );
    assert.ok(list[1].includes(path.join('resources', 'sd')), 'пакетный кандидат после extraResources');
    assert.equal(list[2], EXE);
  });
});

test('sdCandidates: env LITEMIND_SD_BIN идёт первым (высший приоритет)', () => {
  withEnv('E:/runtime/sd.exe', 'C:/inst/resources', () => {
    const list = sdCandidates(null);
    assert.equal(list.length, 4, `кандидатов: ${list.join(' | ')}`);
    assert.equal(list[0], 'E:/runtime/sd.exe');
    assert.ok(list[1].includes('resources'), 'resources-кандидат на месте после env');
  });
});
