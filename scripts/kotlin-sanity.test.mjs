/**
 * Дешёвая проверка Kotlin-исходников встроенного сервера.
 *
 * Это не компилятор: полноценная проверка — `./gradlew assembleRelease` (10+ минут
 * в CI, и тогда причина видна только по обрезанным логам). Здесь два правила,
 * которые реально ломали сборку и стоили полных прогонов:
 *
 *  1. `const val` вне `object`/`companion object` — запрещён в Kotlin («'const'
 *     modifier is not allowed in classes»). Именно так `BOOTSTRAP_ASSET` оказался
 *     в классе сервиса и уронил `compileReleaseKotlin`.
 *  2. обращение `Object.member(…)` к объекту из этого же пакета, которого в файле
 *     нет — опечатка, которую IDE прощает, а компилятор нет.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/mobile/nodejs/android/java/app/vision/audio/node');

const files = readdirSync(SRC).filter((file) => file.endsWith('.kt'));
const sources = new Map(files.map((file) => [file, readFileSync(path.join(SRC, file), 'utf8')]));

test('исходники на месте', () => {
  assert.deepEqual(files.sort(), ['NodeRuntime.kt', 'VisionNodeModule.kt', 'VisionNodePackage.kt', 'VisionNodeService.kt']);
});

test('const val объявлен только в object или companion object', () => {
  const problems = [];
  for (const [file, text] of sources) {
    // Стек блоков: class/object/companion object. Закрываем по `}` без надёжного
    // парсинга — для наших файлов достаточно (нет строк с фигурными скобками в
    // строковых литералах на верхнем уровне).
    const stack = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (/^(private\s+|internal\s+|public\s+)?(companion\s+)?object\b/.test(line)) stack.push('object');
      else if (/^(private\s+|internal\s+|public\s+)?(abstract\s+|open\s+|sealed\s+)?class\b/.test(line)) stack.push('class');
      else if (/^(private\s+|internal\s+|public\s+|override\s+)?fun\b/.test(line)) stack.push('fun');

      if (/^(private\s+|internal\s+|public\s+)?const\s+val\b/.test(line)) {
        const owner = [...stack].reverse().find((entry) => entry !== 'fun');
        if (owner !== 'object') {
          problems.push(`${file}: const val в ${owner ?? 'верхнем уровне файла'}: ${line}`);
        }
      }

      const opens = (raw.match(/\{/g) ?? []).length;
      const closes = (raw.match(/\}/g) ?? []).length;
      for (let i = 0; i < closes - opens; i += 1) stack.pop();
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('ссылки Object.member() между файлами разрешаются', () => {
  // Объекты этого пакета: ServerRunner, а также собственные object-объявления.
  const declared = new Map();
  for (const [file, text] of sources) {
    const names = [...text.matchAll(/\b(fun|val|var|const val)\s+(\w+)/g)].map((match) => match[2]);
    declared.set(file.replace(/\.kt$/, ''), new Set(names));
  }

  const problems = [];
  for (const [file, text] of sources) {
    for (const match of text.matchAll(/\b([A-Z]\w+)\.(\w+)\s*\(/g)) {
      const [, object, member] = match;
      // только наши объекты: файл с таким же именем должен существовать
      const members = declared.get(object);
      if (!members) continue;
      if (!members.has(member)) problems.push(`${file}: ${object}.${member}() не объявлен в ${object}.kt`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('JNI загружается только в изолированном серверном процессе', () => {
  const module = sources.get('VisionNodeModule.kt');
  const runtime = sources.get('NodeRuntime.kt');
  const service = sources.get('VisionNodeService.kt');
  assert.doesNotMatch(module, /System\.loadLibrary\("visionnode"\)/);
  assert.match(runtime, /System\.loadLibrary\("visionnode"\)/);
  assert.match(runtime, /private external fun nativeStart/);
  assert.match(service, /NodeRuntime\.start\(arguments, true\)/);
  assert.match(service, /:vision_node/);

  // JNI-имя соответствует app.vision.audio.node.NodeRuntime (applicationId
  // тестовой сборки на package Kotlin/JNI не влияет).
  const cpp = readFileSync(path.join(ROOT, 'apps/mobile/nodejs/android/vision-node-jni.cpp'), 'utf8');
  assert.match(cpp, /Java_app_vision_audio_node_NodeRuntime_nativeStart/);
});
