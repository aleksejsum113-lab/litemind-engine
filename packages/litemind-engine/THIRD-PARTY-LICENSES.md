# Third-party components / Сторонние компоненты

LiteMind Engine включает и использует следующие сторонние компоненты.
Все лицензии разрешают коммерческое и некоммерческое использование при
сохранении уведомлений об авторских правах.

## 1. Stable Diffusion C++ (stable-diffusion.cpp) — бэкенд генерации изображений

- Источник: https://github.com/leejet/stable-diffusion.cpp
- Версия: master (коммит 32d516c, ветка master, 2026)
- Использование: консольный исполняемый файл `sd` (`sd.exe`), поставляется
  в составе установщика в `resources/sd/`. Модели изображений скачиваются
  пользователем отдельно и в установщик не входят.
- Сборка LiteMind: без инструкций AVX/AVX2/FMA/F16C/SSE4.2/BMI2 —
  запускается на процессорах без AVX (Intel Celeron N5095A и подобные).

```
MIT License

Copyright (c) 2023 leejet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Включает ggml (MIT, https://github.com/ggml-org/ggml) — собирается из
субмодуля того же репозитория; уведомления распространяются вместе с
исходниками сборки.

## 2. Portable AI Studio (Portable-Local-Studio) — референс интеграции

- Источник: https://github.com/techjarves/Portable-Local-Studio
- Лицензия: MIT, Copyright (c) 2026 Tech Jarves
- Использование: проверенные технические решения (выбор официальных сборок
  stable-diffusion.cpp, флаги CPU-режима `--rng cpu`, `--vae-on-cpu`,
  `--vae-tiling`, жизненный цикл процесса) перенесены в собственный код
  LiteMind Engine. Код интерфейса и сервера Portable AI Studio целиком
  НЕ переносился.

```
MIT License

Copyright (c) 2026 Tech Jarves

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. Модели изображений (скачиваются пользователем отдельно)

- Stable Diffusion 1.5 (Runway ML / CompVis / LAION) — лицензия
  CreativeML Open RAIL-M: https://huggingface.co/spaces/CompVis/stable-diffusion-license
- GGUF-кванты: second-state/stable-diffusion-v1-5-GGUF (Hugging Face).
- Веса моделей НЕ входят в установщик LiteMind Engine; пользователь
  скачивает их сам из каталога моделей.

## 4. LLM-модели (скачиваются пользователем отдельно)

- GGUF-кванты сообщества (mradermacher, bartowski, Vikhrmodels и др.) —
  лицензии указаны в записях каталога моделей внутри приложения.

## 5. llama.cpp — runtime LLM (собственная сборка LiteMind)

- Источник: https://github.com/ggml-org/llama.cpp (MIT).
- Поставляется как `resources/llamacpp/llama-server` — сборка без AVX.
