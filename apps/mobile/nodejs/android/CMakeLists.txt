# Сборка libvisionnode.so — моста Java ↔ Node.
#
# Этот файл копируется в Android-проект как
# `android/app/src/main/cpp/visionnode/CMakeLists.txt` (AGP требует именно такое имя)
# и получает путь к рантайму через `-DVISION_NODE_DIR=…` из `app/build.gradle`.
#
# Ожидает рядом распакованный nodejs-mobile для Android:
#
#   apps/mobile/nodejs/android/libnode/include/node/*.h   (+ libuv, openssl, v8)
#   apps/mobile/nodejs/android/libnode/bin/<abi>/libnode.so
#
# Скачивается скриптом `node scripts/fetch-nodejs-mobile.mjs` (версия и URL — в
# apps/mobile/nodejs/android/node-version.json). Каталог libnode в git не попадает:
# это ~120 МБ бинарников на три ABI.

cmake_minimum_required(VERSION 3.18.1)
project(visionnode)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Путь передаётся абсолютным из Gradle: CMakeLists лежит внутри проекта, а рантайм
# и исходник моста — в репозитории, вне сгенерированного каталога.
if(NOT DEFINED VISION_NODE_DIR)
  message(FATAL_ERROR "VISION_NODE_DIR не задан: добавьте arguments \"-DVISION_NODE_DIR=…\" в android.defaultConfig.externalNativeBuild.cmake")
endif()

add_library(visionnode SHARED ${VISION_NODE_DIR}/vision-node-jni.cpp)

# Node-заголовки: `include/node` лежит внутри `include`, потому что Node ищет
# <node/node.h> и <uv.h> одновременно.
target_include_directories(visionnode PRIVATE ${VISION_NODE_DIR}/libnode/include)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
  IMPORTED_LOCATION ${VISION_NODE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)

target_link_libraries(visionnode libnode ${log-lib} android)

# Node на Android собирается с 16 КБ страницами памяти (требование Android 15+).
# Без этого флага линковка выдаёт предупреждение, а на новых устройствах загрузка
# .so падает.
target_link_options(visionnode PRIVATE "-Wl,-z,max-page-size=16384")

# Мост — часть APK: имя совпадает с тем, что грузит `System.loadLibrary("visionnode")`.
set_target_properties(visionnode PROPERTIES OUTPUT_NAME "visionnode")
